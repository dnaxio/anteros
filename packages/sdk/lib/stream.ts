/**
 * Internals of the SSE-consuming methods (`agent.stream`).
 * Kept out of the public surface on purpose.
 */

/** Unbounded async queue — bridges a push producer with a pull consumer. */
export class AsyncQueue<T> {
    #items: T[] = [];
    #waiters: Array<() => void> = [];
    #closed = false;
    #error: any = null;

    push(item: T): void {
        if (this.#closed) return;
        this.#items.push(item);
        for (const wake of this.#waiters.splice(0)) wake();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const wake of this.#waiters.splice(0)) wake();
    }

    fail(error: any): void {
        if (this.#closed) return;
        this.#error = error;
        this.#closed = true;
        for (const wake of this.#waiters.splice(0)) wake();
    }

    async next(): Promise<IteratorResult<T>> {
        for (;;) {
            if (this.#error) throw this.#error;
            if (this.#items.length) return { value: this.#items.shift() as T, done: false };
            if (this.#closed) return { value: undefined as any, done: true };
            await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return { next: () => this.next() };
    }
}

export type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
};

export function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const SEPARATOR = /\r?\n\r?\n/;

/** The `data:` payload of one SSE block (multi-line payloads are joined). */
function dataOf(block: string): string {
    return block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
}

/** The minimal read surface of a stream — DOM and `node:stream/web` disagree on the rest. */
export type ByteReader = {
    read(): Promise<{ value?: Uint8Array; done: boolean }>;
};

/** Read a `text/event-stream` body and yield the `data:` payloads. */
export async function* sseData(
    source: ReadableStream<Uint8Array> | ByteReader,
): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    const reader: ByteReader = typeof (source as ByteReader).read === "function"
        ? source as ByteReader
        : (source as ReadableStream<Uint8Array>).getReader();
    let buffer = "";

    const take = (): string[] => {
        const out: string[] = [];
        let match: RegExpMatchArray | null;
        while ((match = SEPARATOR.exec(buffer)) !== null) {
            const start = match.index ?? 0;
            const block = buffer.slice(0, start);
            buffer = buffer.slice(start + match[0].length);
            const data = dataOf(block);
            if (data) out.push(data);
        }
        return out;
    };

    for (;;) {
        // `reader.cancel()` resolves a pending read with `done` — this is how the
        // consumer stops the stream without aborting the whole request.
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        for (const data of take()) yield data;
    }

    const tail = dataOf(buffer);
    if (tail) yield tail;
}
