import { useRest } from "../database/rest"
import type { Tenant } from "./tenant"


export type Script = {
    _isScript_?: boolean;
    enabled: boolean;
    /**
     * Run in a separate Bun process so heavy work (large JSON, long imports…)
     * never blocks the HTTP server. The subprocess reconnects the tenant DB and
     * rebuilds collection schemas automatically.
     */
    heavy?: boolean;
    /** Max runtime in ms for heavy scripts (default: no timeout) */
    timeout?: number;
    exec: (ctx: {
        rest: InstanceType<typeof useRest>
        /** Report progress — only wired for heavy scripts (sent via IPC to the parent) */
        progress?: (percent: number, info?: any) => void;
        /** Tenant this script runs for */
        tenant?: Tenant;
    }) => void
}
