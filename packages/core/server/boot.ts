
import { createApp } from './hono'
import type { ServerConfig } from '../types/config'
import dayjs from 'dayjs';
import pkg from '../package.json';
import boxen from 'boxen';
import "@colors/colors";
import { cfg, formatConfig } from './config' // import the config
import { syncTenants } from '../database/tenant'
import { syncCollections } from '../database/collection'
import { syncFileCollections } from '../database/file'

import { loadRoutes } from '../lib/routes'
import { runScripts } from '../lib/scripts'
import { io, engineIo, websocket } from './io'
import { loadServices } from '../lib/services'
import { loadSockets } from '../lib/sockets'
import { syncWorkflows } from '../lib/workflow'
import { syncMcpTools } from '../lib/mcp'
import { loadTenantsMiddlewares } from '../lib/middleware'
import crypto from 'node:crypto';
import os from 'node:os';
import { registerMetrics, getMetrics, trackRequest } from './metrics';
import { startMaster, aggregateMetrics } from './cluster';

/** Check if a TCP port is already bound */
async function isPortInUse(port: number): Promise<boolean> {
    try {
        const proc = Bun.spawn(['lsof', '-ti', `:${port}`], { stdout: 'pipe' });
        const output = await new Response(proc.stdout).text();
        await proc.exited;
        return output.trim().length > 0;
    } catch {
        return false;
    }
}

type BootAppOptions = ServerConfig & {

}
async function bootApp(options: BootAppOptions = {} as BootAppOptions) {

    try {

        // Load required resources
        //******************************* */
        options = formatConfig(options);
        await syncTenants(); // sync tenants and connect to database
        await syncCollections(); // sync collections and create collections on database
        await syncFileCollections(); // sync file collections
        await loadServices(); // load services
        await loadSockets(); // load websocket handlers
        await syncWorkflows();
        await syncMcpTools(); // load MCP tools per tenant (mcp/**/*.tool.ts)
        await loadTenantsMiddlewares();
        loadRoutes(); // load routes
        //******************************* */


        // JWT_SECRET check: auto-generate if missing and auth is enabled
        const hasAuth = cfg.collections?.some((c: any) => c.api?.auth?.enabled);
        let jwtSecret = cfg.server.jwt?.secret || Bun.env.JWT_SECRET;
        if (hasAuth && !jwtSecret) {
            // CSPRNG: crypto.randomBytes (not Math.random — predictable)
            jwtSecret = crypto.randomBytes(48).toString('base64url');
            try {
                const envPath = '.env';
                const exists = await Bun.file(envPath).exists();
                const content = exists ? await Bun.file(envPath).text() : '';
                if (!content.includes('JWT_SECRET=')) {
                    const suffix = content ? '\n' : '';
                    await Bun.write(envPath, `${content}${suffix}# Auto-generated on boot\nJWT_SECRET=${jwtSecret}\n`);
                }
                Bun.env.JWT_SECRET = jwtSecret;
                console.log('🔐 JWT_SECRET auto-generated and saved to .env'.gray);
            } catch {
                Bun.env.JWT_SECRET = jwtSecret;
                console.log('⚠ JWT_SECRET auto-generated (in-memory only, could not write .env)'.yellow);
            }
        }

        const PORT = (cfg.server.port || 4000);
        const NAME = cfg.server.name || process.env.APP_NAME || 'SERVER';
        // Widened to `string`: TS narrows `process.env.NODE_ENV` to a literal union
        // ('development' | 'production' | 'test') and drops the 'dev' fallback branch.
        const env: string = process.env.NODE_ENV || Bun.env.NODE_ENV || 'dev';
        // Bun's SO_REUSEPORT: multiple processes can bind the same port (spawn them yourself)
        const reusePort = cfg.server.reusePort ?? false;
        const isWorker = process.env.BUN_WORKER !== undefined;

        // ── MASTER (cluster): spawn workers, aggregate metrics, supervise ──
        if (reusePort && !isWorker) {
            const workersCount = cfg.server.workers ?? os.availableParallelism();
            console.log(`[cluster] Master ${process.pid} spawning ${workersCount} workers…`.gray.bold);

            const master = startMaster({
                workers: workersCount,
                argv: [process.execPath, ...process.argv.slice(1)],
                env: { ...(process.env as Record<string, string>) },
            });

            // Supervision port: aggregated /health (master does NOT serve the main port)
            const metricsPort = cfg.server.metricsPort ?? PORT + 1;
            const metricsServer = Bun.serve({
                port: metricsPort,
                fetch: (req) => {
                    if (new URL(req.url).pathname === '/health') {
                        return Response.json({
                            status: 'ok',
                            master: { pid: process.pid },
                            ...aggregateMetrics(master.metrics()),
                        });
                    }
                    return new Response('Not found', { status: 404 });
                },
            });

            console.log(`[cluster] Aggregated /health → http://localhost:${metricsPort}/health`.gray);

            // Keep the master alive
            return { master, metricsServer } as any;
        }

        // Detect zombie: check if port is already in use when NOT sharing the port
        if (!reusePort && env === 'dev') {
            const occupied = await isPortInUse(PORT);
            if (occupied) {
                console.error(`\n⚠ Port ${PORT} is already in use. Possible zombie server.\n  → Kill it: lsof -ti :${PORT} | xargs kill -9\n`.red.bold);
                process.exit(1);
            }
        }


        const app = createApp();

        const server = Bun.serve({
            port: PORT,
            reusePort: reusePort || isWorker,
            fetch: (req, server) => {
                const url = new URL(req.url);

                // Track every request for the built-in metrics (zero dependency)
                const respond = (p: Response | Promise<Response>) =>
                    Promise.resolve(p).then((res) => {
                        trackRequest(req, res);
                        return res;
                    });

                if (url.pathname === "/socket.io/") {
                    return respond(engineIo.handleRequest(req, server));
                }
                return respond(app.fetch(req, server));
            },
            websocket: websocket,
            maxRequestBodySize: 1024 * 1024 * 100, // 100MB
        })

        // Register server for built-in metrics (GET /health)
        registerMetrics(server);

        // ── WORKER (cluster): report metrics to the master via IPC ──
        if (isWorker && typeof process.send === 'function') {
            setInterval(() => {
                try {
                    process.send!({
                        type: 'metrics',
                        pid: process.pid,
                        metrics: getMetrics(),
                    });
                } catch {}
            }, 5000);
        }

        let box = '';
        const role = isWorker ? 'worker' : (reusePort ? 'master' : 'standalone');
        box += `${NAME}`.gray.underline + ` (PID: ${process.pid}) — ${role}\n\n`
        box += `Env: ${env || 'dev'}`.green.bold + '\n'
        box += `reusePort: ${(reusePort || isWorker) ? 'On'.green.bold : 'Off'.red.bold}\n`.gray.bold
        box += `Url: http://localhost:${PORT}`.gray.bold;
        box += '\n\n';
        box += `Last boot: 🔄 ${dayjs().format('YYYY-MM-DD HH:mm:ss')}`.gray;

        console.log(boxen(box, {
            title: ` @anteros/core ${pkg.version}`,
            padding: 1,
            float: 'left',
            borderColor: 'gray',
            titleAlignment: 'center',
            borderStyle: 'double',
            textAlignment: 'left',
            dimBorder: true
        }))


        // After boot and App ready.
        setTimeout(() => {
            runScripts().catch(); // run scripts

        }, 150);

        return server;
    } catch (err: any) {
        console.error('Failed to boot server', cfg.debug ? err : err?.message);
        process.exit(1);
    }
}

export {
    bootApp
}
