import path from "path";
import { AppError } from "./error";
import { openZip, type ZipArchive } from "./zip";
import type { AgentAttachment, AgentMediaPart, AgentTextPart } from "../types/agent";

/**
 * Attachments — images and documents handed to a model with a run.
 *
 * An LLM only understands three things: **text**, **images** and — for some
 * models — **documents** (PDF). So every file is resolved to one of those:
 *
 * | Input | What the model receives |
 * | --- | --- |
 * | `.md` `.txt` `.json` `.csv` `.tsv` `.yaml` `.xml` `.html` `.log`, code… | the **text**, under a header naming the file |
 * | `.png` `.jpg` `.jpeg` `.webp` `.gif` | an **image** part (base64) — native vision |
 * | `.pdf` | a **file** part (base64) — native document input, where the model supports it |
 * | `.docx` | the **text** extracted from `word/document.xml` (no dependency: the file is a ZIP) |
 * | `.xlsx` | the **rows**, one CSV block per sheet, from the workbook parts |
 * | `.doc` (legacy), anything else | refused — `AGENT_FILE_UNSUPPORTED` |
 *
 * The extraction of `.docx` / `.xlsx` is a deliberate simplification: it reads
 * the text content, not the layout, the styles or the embedded objects. Good
 * enough for a model; never a replacement for a document renderer.
 */

/** Text formats read as-is — the cheapest and most faithful thing to do. */
const TEXT_EXTENSIONS = new Set([
    "md", "markdown", "mdx", "txt", "text", "log",
    "json", "jsonc", "ndjson", "csv", "tsv",
    "yaml", "yml", "toml", "ini", "env",
    "xml", "html", "htm", "svg",
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "php",
    "sql", "sh", "bash", "zsh", "css", "scss", "vue", "svelte", "graphql", "gql",
]);

/** Image formats both providers accept natively. */
const IMAGE_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
};

/** Formats the model can receive as a document part. */
const DOCUMENT_MIME: Record<string, string> = {
    pdf: "application/pdf",
};

/** Extensions worth naming when we refuse a file. */
const OFFICE_BINARY: Record<string, string> = {
    doc: "the legacy .doc format is not readable — convert it to .docx or PDF",
    xls: "the legacy .xls format is not readable — convert it to .xlsx or CSV",
    ppt: "the legacy .ppt format is not readable — convert it to .pptx or PDF",
    pptx: "PowerPoint is not extracted — convert it to PDF",
};

/** One file never exceeds this — a model is not a file server. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Inlined text is capped too: a 40 MB CSV must not become a 40 MB prompt. */
const MAX_TEXT_CHARS = 200_000;

function extensionOf(name: string): string {
    return path.extname(name).replace(/^\./, "").toLowerCase();
}

function unsupported(name: string): AppError {
    const extension = extensionOf(name);
    const hint = OFFICE_BINARY[extension];
    return new AppError(
        hint
            ? `Cannot read '${name}': ${hint}`
            : `Cannot read '${name}': supported attachments are images (png, jpg, webp, gif), PDF, `
            + `docx, xlsx and text formats (md, txt, json, csv, yaml, code…)`,
        { status: 400, code: "AGENT_FILE_UNSUPPORTED" },
    );
}

function tooLarge(name: string, size: number): AppError {
    return new AppError(
        `'${name}' is ${Math.round(size / 1024 / 1024)}MB — the limit is ${MAX_FILE_BYTES / 1024 / 1024}MB`,
        { status: 413, code: "AGENT_FILE_TOO_LARGE" },
    );
}

function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

/** Decode the XML entities an Office part can contain. */
function decodeEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/g, "&");
}

function stripTags(xml: string): string {
    return decodeEntities(xml.replace(/<[^>]*>/g, ""));
}

// ─── Word ────────────────────────────────────────────────────────────────

/** `word/document.xml` → plain text (paragraphs, tabs and breaks preserved). */
function docxText(zip: ZipArchive): string {
    const document = zip.read("word/document.xml");
    if (!document) throw new AppError("Not a readable .docx (no word/document.xml)", {
        status: 400, code: "AGENT_FILE_INVALID",
    });

    const xml = new TextDecoder().decode(document);
    const text = xml
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]*>/g, "");

    return decodeEntities(text)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// ─── Excel ───────────────────────────────────────────────────────────────

/** `xl/sharedStrings.xml` → the strings the cells refer to by index. */
function xlsxSharedStrings(zip: ZipArchive): string[] {
    const shared = zip.read("xl/sharedStrings.xml");
    if (!shared) return [];

    const xml = new TextDecoder().decode(shared);
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
        [...(match[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
            .map((run) => decodeEntities(run[1] ?? ""))
            .join(""));
}

/** `B7` → 1 (0-based column index), so gaps in a row are preserved. */
function columnOf(reference: string): number {
    const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "";
    let index = 0;
    for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
    return Math.max(0, index - 1);
}

function csvCell(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One worksheet → CSV rows (values, not formulas — a model reads values). */
function xlsxSheet(xml: string, shared: string[]): string[] {
    const rows: string[] = [];

    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const attributes = cellMatch[1] ?? "";
            const body = cellMatch[2] ?? "";
            const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
            const reference = /\br="([^"]+)"/.exec(attributes)?.[1] ?? "";
            const position = reference ? columnOf(reference) : cells.length;

            let value = "";
            if (type === "s") {
                const index = Number(stripTags(/\<v\>([\s\S]*?)\<\/v\>/.exec(body)?.[1] ?? ""));
                value = shared[index] ?? "";
            } else if (type === "inlineStr") {
                value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
                    .map((run) => decodeEntities(run[1] ?? "")).join("");
            } else {
                value = decodeEntities(/\<v\>([\s\S]*?)\<\/v\>/.exec(body)?.[1] ?? "");
            }

            while (cells.length < position) cells.push("");
            cells[position] = value;
        }
        rows.push(cells.map(csvCell).join(","));
    }

    return rows;
}

/** Every worksheet, in tab order, as `### <sheet name>` + CSV rows. */
function xlsxText(zip: ZipArchive): string {
    const sheets = zip.names()
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));

    if (!sheets.length) throw new AppError("Not a readable .xlsx (no worksheet)", {
        status: 400, code: "AGENT_FILE_INVALID",
    });

    const shared = xlsxSharedStrings(zip);

    return sheets.map((sheet, index) => {
        const xml = new TextDecoder().decode(zip.read(sheet) ?? new Uint8Array());
        return `### Sheet ${index + 1}\n\n${xlsxSheet(xml, shared).join("\n")}`;
    }).join("\n\n");
}

// ─── Resolution ──────────────────────────────────────────────────────────

/** What a caller can attach — a path (server-side), a `Blob`/`File`, raw bytes, or base64. */
export type NormalizedAttachment = {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
};

/**
 * Read what the caller attached. A string is a **path** on the server (read
 * now, at call time) — the SDK sends base64 instead, since a browser has no
 * filesystem.
 */
async function materialize(attachment: AgentAttachment, baseDir: string): Promise<NormalizedAttachment> {
    if (typeof attachment === "string") {
        const file = path.resolve(baseDir, attachment);
        if (!(await Bun.file(file).exists())) {
            throw new AppError(`Attachment '${attachment}' not found`, { status: 400, code: "AGENT_FILE_NOT_FOUND" });
        }
        const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
        return { name: path.basename(file), mimeType: "", bytes };
    }

    if (attachment instanceof Uint8Array) {
        return { name: "attachment", mimeType: "", bytes: attachment };
    }

    if (typeof Blob !== "undefined" && attachment instanceof Blob) {
        const name = (attachment as File).name ?? "attachment";
        return {
            name,
            mimeType: (attachment as File).type ?? "",
            bytes: new Uint8Array(await attachment.arrayBuffer()),
        };
    }

    const explicit = attachment as { name?: string; mimeType?: string; data: string | Uint8Array; encoding?: "base64" | "utf8" };
    const name = explicit.name ?? "attachment";
    if (explicit.data instanceof Uint8Array) {
        return { name, mimeType: explicit.mimeType ?? "", bytes: explicit.data };
    }

    const encoding = explicit.encoding ?? "base64";
    return {
        name,
        mimeType: explicit.mimeType ?? "",
        bytes: encoding === "utf8"
            ? new TextEncoder().encode(explicit.data)
            : new Uint8Array(Buffer.from(explicit.data, "base64")),
    };
}

/**
 * Turn attachments into **content parts** the providers understand.
 *
 * @returns the parts to append to the current user turn (`[]` when there is
 * nothing to attach). Throws `AGENT_FILE_*` when a file cannot be sent — a
 * silently dropped attachment is worse than a loud failure.
 */
async function resolveAttachments(
    attachments: AgentAttachment | AgentAttachment[] | undefined,
    options: { baseDir?: string } = {},
): Promise<AgentMediaPart[]> {
    if (!attachments) return [];
    const list = Array.isArray(attachments) ? attachments : [attachments];
    if (!list.length) return [];

    const baseDir = options.baseDir ?? process.cwd();
    const parts: AgentMediaPart[] = [];

    for (const attachment of list) {
        const file = await materialize(attachment, baseDir);
        if (file.bytes.byteLength > MAX_FILE_BYTES) throw tooLarge(file.name, file.bytes.byteLength);

        const extension = extensionOf(file.name);
        const declared = file.mimeType.toLowerCase();
        const mimeType = declared || IMAGE_MIME[extension] || DOCUMENT_MIME[extension] || "";

        // 1. Images — native vision on both protocols
        const imageMime = IMAGE_MIME[extension] ?? (declared.startsWith("image/") ? declared : "");
        if (imageMime) {
            parts.push({ type: "image", data: toBase64(file.bytes), mimeType: imageMime });
            continue;
        }

        // 2/3. PDF — a document part (the provider decides what it does with it)
        const documentMime = DOCUMENT_MIME[extension] ?? (declared === "application/pdf" ? declared : "");
        if (documentMime) {
            parts.push({ type: "file", name: file.name, mimeType: documentMime, data: toBase64(file.bytes) });
            continue;
        }

        // 4. Office documents — extracted to text, no dependency
        if (extension === "docx" || extension === "xlsx") {
            const text = extension === "docx"
                ? docxText(openZip(file.bytes))
                : xlsxText(openZip(file.bytes));
            parts.push({ type: "text", text: textPart(file.name, text) });
            continue;
        }

        // 5. Text formats — read as-is
        if (TEXT_EXTENSIONS.has(extension) || declared.startsWith("text/") || declared === "application/json") {
            const text = new TextDecoder().decode(file.bytes);
            parts.push({ type: "text", text: textPart(file.name, text) });
            continue;
        }

        throw unsupported(file.name);
    }

    return parts;
}

/** A file's text under a header naming it — the model must know where it comes from. */
function textPart(name: string, text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= MAX_TEXT_CHARS) return `--- ${name} ---\n${trimmed}`;
    return `--- ${name} (truncated) ---\n${trimmed.slice(0, MAX_TEXT_CHARS)}`;
}

/**
 * What a **memory** keeps of an attachment. Conversations are text: storing a
 * 5 MB image in every turn would fill the store for nothing, and the model
 * already read it once. The reply and the question stay verbatim.
 */
function attachmentNote(part: AgentMediaPart): string {
    if (part.type === "image") return "[image]";
    if (part.type === "file") return `[file ${part.name ?? "document"}]`;
    const header = /^--- (.+?) ---/.exec(part.text)?.[1];
    return header ? `[file ${header}]` : "";
}

/** A part as it should be *stored* — the heavy payloads replaced by a note. */
function forMemory(part: AgentMediaPart): AgentTextPart {
    if (part.type === "text") return part;
    return { type: "text", text: attachmentNote(part) };
}

export {
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS,
    docxText,
    forMemory,
    resolveAttachments,
    xlsxText,
};
