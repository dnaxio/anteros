import { describe, it, expect } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { openZip } from "../lib/zip";
import { docxText, resolveAttachments, xlsxText, MAX_FILE_BYTES } from "../lib/attachment";
import { openaiMessages, anthropicMessages } from "../lib/providers";

/**
 * Attachments — a file becomes text, an image or a document part, and the zip
 * reader behind `.docx` / `.xlsx` is exercised against **real** archives built by
 * `makeZip` (the same bytes Office writes: local headers + central directory).
 */

/** Minimal ZIP writer (deflate or stored) — enough to build a .docx/.xlsx fixture. */
function makeZip(entries: Record<string, string>, options: { store?: boolean } = {}): Uint8Array {
    const encoder = new TextEncoder();
    const locals: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    const crcTable = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[i] = c >>> 0;
        }
        return table;
    })();

    const crc32 = (bytes: Uint8Array): number => {
        let crc = 0xffffffff;
        for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    };

    for (const [name, content] of Object.entries(entries)) {
        const raw = encoder.encode(content);
        const method = options.store ? 0 : 8;
        const data = options.store ? raw : new Uint8Array(deflateRawSync(raw));
        const nameBytes = encoder.encode(name);
        const crc = crc32(raw);

        const local = new Uint8Array(30 + nameBytes.length + data.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);           // version
        localView.setUint16(8, method, true);
        localView.setUint32(14, crc, true);
        localView.setUint32(18, data.length, true); // compressed
        localView.setUint32(22, raw.length, true);  // uncompressed
        localView.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);
        locals.push(local);

        const entry = new Uint8Array(46 + nameBytes.length);
        const entryView = new DataView(entry.buffer);
        entryView.setUint32(0, 0x02014b50, true);
        entryView.setUint16(4, 20, true);           // version made by
        entryView.setUint16(6, 20, true);           // version needed
        entryView.setUint16(10, method, true);
        entryView.setUint32(16, crc, true);
        entryView.setUint32(20, data.length, true);
        entryView.setUint32(24, raw.length, true);
        entryView.setUint16(28, nameBytes.length, true);
        entryView.setUint32(42, offset, true);      // local header offset
        entry.set(nameBytes, 46);
        central.push(entry);

        offset += local.length;
    }

    const centralSize = central.reduce((total, entry) => total + entry.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, central.length, true);
    endView.setUint16(10, central.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    const total = offset + centralSize + 22;
    const zip = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of [...locals, ...central, end]) {
        zip.set(chunk, cursor);
        cursor += chunk.length;
    }
    return zip;
}

const DOCX = makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml":
        '<w:body><w:p><w:r><w:t>Invoice INV-2026-001</w:t></w:r></w:p>'
        + "<w:p><w:r><w:t>Total: 1 200 &amp; 50 EUR</w:t></w:r></w:p>"
        + "<w:p><w:r><w:tab/><w:t>Paid</w:t></w:r></w:p></w:body>",
});

const XLSX = makeZip({
    "xl/sharedStrings.xml":
        "<sst><si><t>Product</t></si><si><r><t>Widget</t></r><r><t> A</t></r></si>"
        + "<si><t>Invoice INV-2026-001</t></si></sst>",
    "xl/worksheets/sheet1.xml":
        "<worksheet><sheetData>"
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>99.5</v></c><c r="C2" t="inlineStr"><is><t>x,y</t></is></c></row>'
        + "</sheetData></worksheet>",
});

const qr = await resolveAttachments({ name: "photo.png", mimeType: "image/png", data: Buffer.from("PNG!").toString("base64") });

describe("openZip", () => {
    it("lists and reads the entries of a deflated archive", () => {
        const zip = openZip(XLSX);
        expect(zip.names().sort()).toEqual(["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
        expect(new TextDecoder().decode(zip.read("xl/sharedStrings.xml")!)).toContain("Invoice");
        expect(zip.read("nope.xml")).toBeNull();
    });

    it("reads stored entries too, and refuses a non-archive", () => {
        const zip = openZip(makeZip({ "a.txt": "hello" }, { store: true }));
        expect(new TextDecoder().decode(zip.read("a.txt")!)).toBe("hello");

        expect(() => openZip(new TextEncoder().encode("not a zip at all"))).toThrow(/central directory/);
    });
});

describe("office extraction", () => {
    it("extracts the text of a .docx, one line per paragraph", () => {
        const text = docxText(openZip(DOCX));
        expect(text).toContain("Invoice INV-2026-001");
        expect(text).toContain("Total: 1 200 & 50 EUR"); // entities decoded
        expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    });

    it("extracts the rows of a .xlsx as CSV, shared strings resolved", () => {
        const text = xlsxText(openZip(XLSX));
        expect(text).toContain("### Sheet 1");
        expect(text).toContain("Product,Widget A");           // concatenated runs
        expect(text).toContain("Invoice INV-2026-001,99.5");  // shared string + number
        expect(text).toContain('"x,y"');                      // a value with a comma is quoted
    });
});

describe("resolveAttachments", () => {
    it("turns text formats into a text part naming the file", async () => {
        const parts = await resolveAttachments(
            { name: "data.csv", data: Buffer.from("a,b\n1,2").toString("base64") },
        );
        expect(parts).toHaveLength(1);
        expect(parts[0]).toEqual({ type: "text", text: "--- data.csv ---\na,b\n1,2" });
    });

    it("accepts UTF-8 payloads without base64", async () => {
        const parts = await resolveAttachments({ name: "notes.md", data: "# Hi", encoding: "utf8" });
        expect((parts[0] as any).text).toBe("--- notes.md ---\n# Hi");
    });

    it("keeps an image as an image part", () => {
        expect(qr[0]).toEqual({ type: "image", data: Buffer.from("PNG!").toString("base64"), mimeType: "image/png" });
    });

    it("keeps a PDF as a document part", async () => {
        const parts = await resolveAttachments({ name: "invoice.pdf", data: Buffer.from("%PDF-1.7").toString("base64") });
        expect(parts[0]).toEqual({
            type: "file",
            name: "invoice.pdf",
            mimeType: "application/pdf",
            data: Buffer.from("%PDF-1.7").toString("base64"),
        });
    });

    it("extracts .docx and .xlsx to text", async () => {
        const [docx, xlsx] = await resolveAttachments([
            { name: "invoice.docx", data: Buffer.from(DOCX).toString("base64") },
            { name: "sales.xlsx", data: Buffer.from(XLSX).toString("base64") },
        ]);

        expect((docx as any).text).toContain("--- invoice.docx ---");
        expect((docx as any).text).toContain("Invoice INV-2026-001");
        expect((xlsx as any).text).toContain("Product,Widget A");
    });

    it("reads a path on the server — relative to the base dir", async () => {
        const parts = await resolveAttachments("./fixtures/attachment/data.csv", {
            baseDir: "packages/core/tests",
        });
        expect((parts[0] as any).text).toBe("--- data.csv ---\nref,total\nA-1,99");
    });

    it("refuses what a model cannot read, and says why", async () => {
        await expect(resolveAttachments(
            { name: "legacy.doc", data: Buffer.from("D0CF11E0").toString("base64") },
        )).rejects.toMatchObject({ code: "AGENT_FILE_UNSUPPORTED" });

        await expect(resolveAttachments(
            { name: "archive.tar.gz", data: Buffer.from("...").toString("base64") },
        )).rejects.toThrow(/supported attachments/);

        await expect(resolveAttachments("./fixtures/attachment/missing.pdf", {
            baseDir: "packages/core/tests",
        })).rejects.toMatchObject({ code: "AGENT_FILE_NOT_FOUND" });
    });

    it("refuses a file over the size limit", async () => {
        const oversized = { name: "big.pdf", data: new Uint8Array(MAX_FILE_BYTES + 1) };
        await expect(resolveAttachments(oversized)).rejects.toMatchObject({ code: "AGENT_FILE_TOO_LARGE" });
    });
});

describe("attachments through a provider", () => {
    it("maps an image and a PDF to both protocols", () => {
        const messages = [{
            role: "user" as const,
            content: [
                { type: "text" as const, text: "What is this?" },
                { type: "image" as const, data: "AAAA", mimeType: "image/png" },
                { type: "file" as const, name: "invoice.pdf", mimeType: "application/pdf", data: "BBBB" },
            ],
        }];

        const openai = openaiMessages(undefined, messages as any)[0];
        expect(openai.content[0]).toEqual({ type: "text", text: "What is this?" });
        expect(openai.content[1].image_url.url).toBe("data:image/png;base64,AAAA");
        expect(openai.content[2]).toEqual({
            type: "file",
            file: { filename: "invoice.pdf", file_data: "data:application/pdf;base64,BBBB" },
        });

        const anthropic = anthropicMessages(messages as any).messages[0];
        expect(anthropic.content[1]).toEqual({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
        });
        expect(anthropic.content[2]).toEqual({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "BBBB" },
        });
    });
});
