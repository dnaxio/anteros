import { AsyncLocalStorage } from "async_hooks";

const asyncContextStorage = new AsyncLocalStorage<Map<string, unknown>>();

const REQUEST_STORAGE_PREFIX = ":::requestStorage:::";
const SESSION_STORAGE_PREFIX = "::sessionStorage::";

const requestCtxStorage = {
    set(key: string, value: unknown): void {
        asyncContextStorage.getStore()?.set(`${REQUEST_STORAGE_PREFIX}${key}`, value);
    },
    get<T = unknown>(key: string): T | undefined {
        return asyncContextStorage.getStore()?.get(`${REQUEST_STORAGE_PREFIX}${key}`) as T | undefined;
    },
    delete(key: string): void {
        asyncContextStorage.getStore()?.delete(`${REQUEST_STORAGE_PREFIX}${key}`);
    },
    clear(): void {
        asyncContextStorage.getStore()?.clear();
    }
};

interface SessionSetParams {
    state: {
        user: Record<string, unknown>;
        [key: string]: unknown;
    };
    role: string;
    token?: string;
    expireIn?: number;
}

interface SessionData {
    state: SessionSetParams["state"];
    uuid: string;
    role: string;
    token?: string;
    expireIn?: number;
    isAuth: boolean;
    _v: unknown;
}

const sessionCtxStorage = {
    set(params: SessionSetParams): void {
        const store = asyncContextStorage.getStore();
        if (!store) return;
        const data: SessionData = {
            state: params.state,
            uuid: crypto.randomUUID(),
            role: params.role,
            token: params.token,
            expireIn: params.expireIn,
            isAuth: !!params.state?.user && !!params.token,
            _v: undefined,
        };
        store.set(SESSION_STORAGE_PREFIX, data);
    },
    get(): SessionData | undefined {
        return asyncContextStorage.getStore()?.get(SESSION_STORAGE_PREFIX) as SessionData | undefined;
    },
    clear(): void {
        asyncContextStorage.getStore()?.delete(SESSION_STORAGE_PREFIX);
    }
};


export { asyncContextStorage, requestCtxStorage, sessionCtxStorage };

