import type { FileResult, RestRequestOptions } from "../types/rest";

/** What the files namespace calls to reach the wire — `Rest` owns the transport. */
type PostForm = (collection: string, formData: FormData, signal?: AbortSignal) => Promise<any>;
type BuildFileUrl = (collection: string, file: string) => string;
type Remove = (url: string, signal?: AbortSignal) => Promise<any>;

/** The image transformations a served file accepts. */
type FileTransform = {
    width?: number;
    height?: number;
    format?: "webp" | "jpeg" | "png" | "avif";
    quality?: number;
};

/**
 * File collections — `api.files`.
 *
 * ```ts
 * const photos = api.files;
 *
 * const file = await photos.upload('photos', input.files[0], { alt: 'Cover' });
 * photos.url('photos', file._file.filename, { width: 400, format: 'webp' });
 * await photos.delete('photos', file._id);
 * ```
 */
class Files {
    #postForm: PostForm;
    #buildUrl: BuildFileUrl;
    #remove: Remove;

    constructor(postForm: PostForm, buildUrl: BuildFileUrl, remove: Remove) {
        this.#postForm = postForm;
        this.#buildUrl = buildUrl;
        this.#remove = remove;
    }

    /**
     * Upload one or several files (`multipart/form-data`) — one document per file.
     * `data` carries the collection's custom fields.
     *
     * @returns the document for a single file, an array for several.
     */
    async upload<T extends FileResult = FileResult>(
        collection: string,
        file: Blob | File | (Blob | File)[],
        data?: Record<string, any>,
        opts?: {
            fieldName?: string;
            signal?: AbortSignal;
        },
    ): Promise<T | T[]> {
        const files = Array.isArray(file) ? file : [file];
        const fieldName = opts?.fieldName ?? "file";
        const formData = new FormData();
        for (const entry of files) formData.append(fieldName, entry);

        if (data) {
            for (const [key, value] of Object.entries(data)) formData.append(key, String(value));
        }

        return this.#postForm(collection, formData, opts?.signal);
    }

    /**
     * The URL serving a file, with optional image transformations.
     *
     * ```ts
     * api.files.url('photos', '507f1f77.jpg', { width: 200, format: 'webp' });
     * // …/api/v1/files/photos/507f1f77.jpg?w=200&format=webp
     * ```
     */
    url(collection: string, filename: string, transform?: FileTransform): string {
        const base = this.#buildUrl(collection, filename);
        if (!transform) return base;

        const params = new URLSearchParams();
        if (transform.width) params.set("w", String(transform.width));
        if (transform.height) params.set("h", String(transform.height));
        if (transform.format) params.set("format", transform.format);
        if (transform.quality) params.set("q", String(transform.quality));

        const query = params.toString();
        return query ? `${base}?${query}` : base;
    }

    /** Delete a file document by its `_id` (what `upload()` returned). */
    async delete<TResponse = { message: string; ok: boolean }>(
        collection: string,
        fileId: string,
        options?: RestRequestOptions & { signal?: AbortSignal },
    ): Promise<TResponse> {
        return this.#remove(this.#buildUrl(collection, fileId), options?.signal);
    }
}

export { Files };
export type { FileTransform };
