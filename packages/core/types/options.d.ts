type LookupOptions = {
    from: string;
    localField: string;
    foreignField: string;
    as?: string;
    pipeline?: Array<any>;
}