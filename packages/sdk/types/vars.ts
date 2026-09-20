/** Scope option shared by every `api.vars` method. */
export type VarsScopeOptions = { scope?: any };

export type VarsSetOptions = VarsScopeOptions & {
    /** Annotation values — validated server-side against the namespace `meta` fields. */
    meta?: Record<string, any>;
    /** Time-to-live — human string (`'30m'`) or ms. Pass `null` to clear an existing TTL. */
    ttl?: string | number | null;
};

export type VarsAllOptions = VarsScopeOptions & {
    /** Filter on `meta` fields (e.g. `{ note: 'x' }`). */
    where?: Record<string, any>;
};

/** A stored variable entry, as returned by `api.vars.entry()` / `.entries()`. */
export type VarEntry<T = any> = {
    ns: string;
    key: string;
    scope: any;
    value: T;
    meta: Record<string, any>;
    expiresAt: string | Date | null;
    createdAt?: string | Date;
    updatedAt: string | Date;
};
