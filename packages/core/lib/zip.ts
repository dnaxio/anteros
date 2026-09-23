import { inflateRawSync } from "node:zlib";
import { AppError } from "./error";

/**
 * A minimal, **read-only** ZIP reader — enough to open a `.docx` or a `.xlsx`
 * (both are ZIP containers) without adding a dependency.
 *
 * `Bun.Archive` only handles tar, and a document is not worth a package: the
 * central directory of a ZIP is a simple, stable structure — find it, list the
 * entries, inflate the one you need. Entries are decompressed **lazily**, so a
 * workbook full of images never pays for them.
 *
 * Deliberately not supported (they never appear in an Office file): ZIP64
 * archives, encrypted entries and multi-disk sets.
 */

const SIGNATURE = {
    end: 0x06054b50,
    central: 0x02014b50,
    local: 0x04034b50,
} as const;

/** Zip entries are never larger than this in a document we read — sanity guard. */
const MAX_EOCD_SCAN = 65_535 + 22; // the folder comment cap + the record itself

type Entry = {
    method: number;
    compressedSize: number;
    localOffset: number;
};

export type ZipArchive = {
    /** Every entry name, in central-directory order. */
    names(): string[];
    /** The decompressed bytes of an entry, or `null` when it does not exist. */
    read(name: string): Uint8Array | null;
};

function bad(reason: string): AppError {
    return new AppError(`Unreadable archive: ${reason}`, { status: 400, code: "AGENT_FILE_INVALID" });
}

/** Open a ZIP buffer — throws `AGENT_FILE_INVALID` when it is not a readable ZIP. */
function openZip(buffer: Uint8Array): ZipArchive {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // ── End Of Central Directory — the only reliable place to start ───────
    let end = -1;
    const lowest = Math.max(0, buffer.length - MAX_EOCD_SCAN);
    for (let offset = buffer.length - 22; offset >= lowest; offset--) {
        if (view.getUint32(offset, true) === SIGNATURE.end) {
            end = offset;
            break;
        }
    }
    if (end < 0) throw bad("no ZIP central directory (is it a real .docx/.xlsx?)");

    const entries = new Map<string, Entry>();
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);

    // ── Central directory ────────────────────────────────────────────────
    for (let index = 0; index < count; index++) {
        if (offset + 46 > buffer.length || view.getUint32(offset, true) !== SIGNATURE.central) {
            throw bad("truncated central directory");
        }

        const method = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localOffset = view.getUint32(offset + 42, true);

        if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw bad("ZIP64 archives are not supported");
        }

        const name = new TextDecoder().decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
        entries.set(name, { method, compressedSize, localOffset });
        offset += 46 + nameLength + extraLength + commentLength;
    }

    return {
        names: () => [...entries.keys()],

        read(name: string): Uint8Array | null {
            const entry = entries.get(name);
            if (!entry) return null;

            // The local header repeats the name/extra — the payload starts after them.
            const local = entry.localOffset;
            if (local + 30 > buffer.length || view.getUint32(local, true) !== SIGNATURE.local) {
                throw bad(`corrupted entry '${name}'`);
            }

            const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            const data = buffer.subarray(start, start + entry.compressedSize);
            if (start + entry.compressedSize > buffer.length) throw bad(`truncated entry '${name}'`);

            // 0 = stored, 8 = deflate — the only two methods Office writes
            if (entry.method === 0) return data;
            if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
            throw bad(`unsupported compression method ${entry.method} for '${name}'`);
        },
    };
}

export { openZip };
