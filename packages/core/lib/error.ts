class AppError extends Error {
    code: number | string | undefined | null;
    status: number | string;
    reason: any;
    meta?: { [key: string]: any };
    constructor(message: string, options: { status?: number | string | undefined, reason?: any, codeName?: any, code?: number | string } = {}, meta?: { [key: string]: any }) {
        super(message);
        this.status = options?.status ?? 500;
        this.reason = options?.reason;
        this.code = options?.code;
        this.meta = meta || {};
    }
}

const fn = {
    error: (message: string, options: { status?: number | string | undefined, reason?: any, codeName?: any, code?: number | string } = {}, meta?: { [key: string]: any }) => {
        throw new AppError(message, options, meta);
    },
}

export { AppError, fn }