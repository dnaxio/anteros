export type ApiAction =
    | "insertOne"
    | "insertMany"
    | "updateOne"
    | "updateMany"
    | "deleteOne"
    | "deleteMany"
    | "findOne"
    | "find"
    | "runAction"
    | "runService"
    | "upload"
    | "auth"
    | "login"
    | "logout"
    | string;

export type RestQueryOptions = {
    cleanDeep?: boolean;
    useCache?: boolean;
    [key: string]: unknown;
};

export type RestRequestOptions = {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    query?: RestQueryOptions;
    /**
     * If true, cleans the body before sending (removes null, undefined, empty arrays, empty objects).
     */
    cleanDeep?: boolean;
    /** Serve `find` from the server-side DB query cache (invalidated on writes). TTL is managed server-side (collection/server config). `findOne` is never cached */
    useCache?: boolean;
};

export type RestClientOptions = {
    server: string;
    tenant: string;
    headers?: Record<string, string>;
    token?: {
        persist?: boolean;
        storageKey?: string;
    };
    /** Default params merged into CRUD calls. Provided params take priority. */
    defaultParams?: {
        find?: FindOptions;
        findOne?: Record<string, unknown>;
        insertOne?: Record<string, unknown>;
        insertMany?: Record<string, unknown>;
        updateOne?: Record<string, unknown>;
        updateMany?: Record<string, unknown>;
        deleteOne?: Record<string, unknown>;
        deleteMany?: Record<string, unknown>;
        aggregate?: Record<string, unknown>;
    };
};

/**
 * What a client reports to its listeners.
 *
 * - `error` — **every** failure: a server error (with its `code`/`status`/`meta`), a
 *   network failure (`SDK_NETWORK_ERROR`), a stream that failed mid-flight.
 * - `unauthorized` — the same error, when the server answered **401**. Emitted **in
 *   addition to** `error`, so an application reacts to a dead token without matching
 *   on a string.
 *
 * A request the caller **aborted** (`AbortSignal`) reports nothing: cancelling is not
 * a failure, and the throw is unchanged.
 */
export type SdkEvent = "error" | "unauthorized";

/**
 * The error every SDK method throws — and the object handed to a listener.
 *
 * ```ts
 * api.on("unauthorized", () => api.logout());
 *
 * api.on("error", (err) => {
 *   if (err.code === "INVALID_TOKEN") redirectToLogin();
 * });
 * ```
 */
export type AnterosError = Error & {
    /** Stable code — the server's (`COLLECTION_NOT_FOUND`, `INVALID_TOKEN`…) or the SDK's (`SDK_NETWORK_ERROR`). */
    code?: string;
    /** HTTP status; absent when the request never reached the server. */
    status?: number;
    /** Whatever the server attached (a field list, a slug…). */
    meta?: any;
    /** The underlying failure — the `fetch` `TypeError`, an `AbortError`… */
    cause?: any;
};

/** A listener registered with `on` / `once`. */
export type SdkListener = (error: AnterosError) => void;


export type FindOptions = {
    $limit?: number;
    $skip?: number;
    $sort?: {
        [key: string]: 1 | -1;
    };
    $project?: Record<string, unknown>;
    $match?: Record<string, unknown>;
    $include?: Array<string | LookupOptions>;
    $lookup?: Array<Record<string, any>>;
    $graphLookup?: Array<Record<string, any>>;
};

export type LookupOptions = {
    from: string;
    localField: string;
    foreignField: string;
    as?: string;
    pipeline?: Array<any>;
} | string;

export type FileResult = {
  _id: string;
  /** ISO string — set on upload */
  createdAt?: string;
  /** ISO string — refreshed when the metadata is completed */
  updatedAt?: string;
  _file: {
    filename: string;
    name: string;
    mimetype: string;
    size: number;
    url: string;
  };
  [key: string]: any;
};

export type PublicConfig = {
  tenants: { id: string; name?: string }[];
  collections: {
    _tenant_?: string;
    slug: string;
    type?: string;
    actions?: string[];
    fields?: {
      name: string;
      type: string;
      description?: string;
      required?: boolean;
      nullable?: boolean;
      empty?: boolean;
      relation?: { to: string; hasMany?: boolean };
      enumOptions?: any;
      randomOptions?: any;
      defaultValue?: any;
      studio?: { label?: string; info?: string; display?: string };
    }[];
    readOnlyFields?: (string | RegExp)[];
    studio?: { label?: string; info?: string };
  }[];
  services: {
    _tenant_?: string;
    name: string;
    enabled: boolean;
    actions: string[];
  }[];
  fileCollections: {
    _tenant_?: string;
    slug: string;
    fields?: {
      name: string;
      type: string;
      description?: string;
      required?: boolean;
      nullable?: boolean;
      empty?: boolean;
      relation?: { to: string; hasMany?: boolean };
      enumOptions?: any;
      randomOptions?: any;
      defaultValue?: any;
      studio?: { label?: string; info?: string; display?: string };
    }[];
    readOnlyFields?: (string | RegExp)[];
  }[];
};

export type UploadOptions = {
  /** Field name used in the multipart body. Default: 'file' */
  fieldName?: string;
  /** Abort signal */
  signal?: AbortSignal;
  /** Additional fields to store alongside the file */
  [key: string]: any;
};
