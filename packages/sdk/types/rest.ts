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
     * Si true, nettoie le body avant envoi (supprime null, undefined, tableaux vides, objets vides).
     */
    cleanDeep?: boolean;
};

export type RestClientOptions = {
    server: string;
    tenant: string;
    headers?: Record<string, string>;
    token?: {
        persist?: boolean;
        storageKey?: string;
    };

};


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
