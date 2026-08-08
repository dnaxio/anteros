import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { Script } from "../types/scripts"
import type { Tenant } from "../types/tenant"
import { useRest } from "../database/rest"
import { asyncContextStorage, requestCtxStorage } from "./asyncContextStorage"


// Path of the heavy-script worker entrypoint (spawned as its own Bun process)
const WORKER_PATH = path.join(import.meta.dir, 'scriptWorker.ts');

/**
 * Run a `heavy` script in a separate Bun process so it never blocks the HTTP
 * server. The worker reconnects the tenant DB and rebuilds collection schemas.
 * Progress is reported back via IPC when the script calls `progress(...)`.
 */
async function runHeavyScript(file: string, tenant: Tenant, timeout?: number): Promise<void> {
    const scriptPath = path.resolve(file);
    const proc = Bun.spawn(['bun', 'run', WORKER_PATH, scriptPath], {
        env: { ...process.env },
        stdin: 'pipe',
        stdout: 'inherit',
        stderr: 'inherit',
        ipc: (message: any) => {
            if (message?.type === 'progress') {
                console.log(`[script:${path.basename(file)}] ${message.percent}%`, message.info ?? '');
            } else if (message?.type === 'error') {
                console.error(`[script:${path.basename(file)}]`, message?.message);
            }
        },
    });

    // Send the serializable tenant config (uri/options only — never client/db
    // Mongo instances, which are not JSON-serializable)
    const payload = JSON.stringify({
        tenant: {
            id: tenant.id,
            name: tenant.name,
            description: tenant.description,
            dir: tenant.dir,
            routes: tenant.routes,
            database: {
                uri: tenant.database?.uri,
                options: tenant.database?.options,
            },
        },
    });
    proc.stdin.write(payload);
    proc.stdin.end();

    // Optional hard timeout — kills the worker if it exceeds it
    const timer = timeout ? setTimeout(() => {
        console.error(`[script:${path.basename(file)}] timed out after ${timeout}ms — killing`);
        proc.kill();
    }, timeout) : null;

    const code = await proc.exited;
    if (timer) clearTimeout(timer);
    if (code !== 0) {
        console.error(`[script:${path.basename(file)}] exited with code ${code}`);
    }
}


async function runScripts() {
    type ScriptEntry = { script: Script; file: string; tenant: Tenant };
    const entries: ScriptEntry[] = [];
    for (let tenant of cfg.tenants ?? []) {
        const TENANT_PATH = path.join(process.cwd(), tenant.dir)
        const SCRIPTS_PATH = path.join(TENANT_PATH, 'scripts')
        let exist = await fs.exists(SCRIPTS_PATH)
        if (!exist) continue;
        const isDirectory = await (await fs.stat(SCRIPTS_PATH)).isDirectory()
        if (isDirectory) {
            const glob = new Glob(path.join(SCRIPTS_PATH, '**/*.run.ts'))
            for await (let file of glob.scan('.')) {
                let scriptModule = await import(file)
                if (scriptModule?.default?._isScript_ && scriptModule?.default?.enabled) {
                    entries.push({ script: scriptModule.default, file, tenant })
                }
            }
        }
    }

    const heavyTasks: Promise<void>[] = [];
    for (const { script, file, tenant } of entries) {
        if (script.heavy) {
            // Heavy scripts run in a subprocess — never block the server
            heavyTasks.push(runHeavyScript(file, tenant, script.timeout));
            continue;
        }

        await asyncContextStorage.run(new Map(), async () => {
            requestCtxStorage.set('trace', { id: crypto.randomUUID() })
            requestCtxStorage.set('internal', true)
            await script.exec({
                rest: new useRest({ tenant_id: tenant.id }),
                tenant,
            })
        })
    }

    // Wait for all heavy subprocesses (they keep running after this resolves)
    if (heavyTasks.length) {
        await Promise.allSettled(heavyTasks);
    }
}
export {
    runScripts
}
