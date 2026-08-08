import { cfg } from "../server/config";
import { useRest } from "../database/rest";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { syncFileCollections } from "../database/file";
import { asyncContextStorage, requestCtxStorage } from "./asyncContextStorage";

// ─── Heavy-script worker entrypoint ─────────────────────────────────────────
// Spawned by runScripts() for scripts marked `heavy: true`.
//
//   bun run lib/scriptWorker.ts <absolute-script-path>
//
// The tenant config (id, dir, database.uri…) is received as JSON on **stdin**
// (never argv, to avoid leaking credentials in `ps`). The worker rebuilds the
// minimal app context — tenant DB connection + collection schemas — then runs
// the script and reports progress via IPC (process.send).

async function main() {
    const scriptPath = process.argv[2];
    if (!scriptPath) {
        console.error('[script-worker] usage: scriptWorker <scriptPath>');
        process.exit(1);
    }

    // Read the tenant config from stdin (written by the parent)
    let tenant: any;
    try {
        const input = (await new Response(process.stdin).json()) as { tenant?: any };
        tenant = input?.tenant;
    } catch (err: any) {
        console.error('[script-worker] failed to read tenant config from stdin:', err?.message);
        process.exit(1);
    }
    if (!tenant?.id || !tenant?.database?.uri) {
        console.error('[script-worker] missing tenant config (id / database.uri)');
        process.exit(1);
    }

    try {
        // Rebuild the app context, same as boot: connect DB, load collection schemas
        cfg.tenants = [tenant];
        await syncTenants();
        await syncCollections();
        await syncFileCollections();
    } catch (err: any) {
        console.error('[script-worker] failed to bootstrap context:', err?.message);
        process.exit(1);
    }

    const module = await import(scriptPath);
    const script = module?.default;
    if (!script?._isScript_ || !script.enabled) {
        console.error(`[script-worker] '${scriptPath}' is not an enabled script`);
        process.exit(1);
    }

    const rest = new useRest({ tenant_id: tenant.id });
    const progress = (percent: number, info?: any) =>
        process.send?.({ type: 'progress', percent, info });

    try {
        await asyncContextStorage.run(new Map(), async () => {
            requestCtxStorage.set('trace', { id: crypto.randomUUID() });
            requestCtxStorage.set('internal', true);
            await script.exec({ rest, progress, tenant });
        });
        process.send?.({ type: 'done' });
        process.exit(0);
    } catch (err: any) {
        process.send?.({ type: 'error', message: err?.message });
        console.error('[script-worker] script failed:', err);
        process.exit(1);
    }
}

main();
