
import { createApp, collectHeaders } from './hono'
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
import tcpPortUsed from 'tcp-port-used';
import { logger } from '../utils/logger';

type BootAppOptions = ServerConfig & {

}
async function bootApp(options: BootAppOptions = {} as BootAppOptions) {

    try {

        // Load required resources
        //******************************* */
        options = formatConfig(options);

        // Logging: configure from cfg.server.logging (console + file, e.g. logs/anteros.log)
        logger.configure(cfg.server.logging);
        logger.info('Starting Anteros server', {
            name: cfg.server.name ?? process.env.APP_NAME ?? 'SERVER',
            port: cfg.server.port ?? 4000,
            env: process.env.NODE_ENV || Bun.env.NODE_ENV || 'dev',
            tenants: cfg.tenants?.map((t) => t.id),
        });
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

            // Graceful shutdown: stop workers + metrics server so a restart
            // (e.g. bun --watch) never leaves the port occupied
            const shutdownCluster = (signal: string) => {
                console.log(`\n${signal} received — shutting down workers…`.gray);
                try { master.shutdown(); } catch {}
                try { metricsServer.stop(true); } catch {}
                for (const tenant of cfg.tenants ?? []) {
                    try { tenant.database?.client?.close(); } catch {}
                }
                process.exit(0);
            };
            process.once('SIGINT', () => shutdownCluster('SIGINT'));
            process.once('SIGTERM', () => shutdownCluster('SIGTERM'));

            // Keep the master alive
            return { master, metricsServer } as any;
        }

        // Detect zombie: check if port is already in use when NOT sharing the port.
        // tcp-port-used probes with a real TCP connection — only a listening server
        // counts (a connected client never triggers a false positive) and it works
        // on any platform (no lsof dependency). Grace period: after a restart the
        // previous process may still be releasing the port (Mongo / Socket.IO
        // shutdown) — wait before declaring a zombie.
        if (!reusePort && env === 'dev') {
            if (await tcpPortUsed.check(PORT)) {
                console.log(`⏳ Port ${PORT} is still held, waiting for the previous process to release it (~2.5s)…`.gray);
            }
            try {
                // ~2.5s grace (5 × 500ms); rejects if the port stays occupied
                await tcpPortUsed.waitUntilFree(PORT, 500, 2500);
            } catch {
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
                    const start = performance.now();
                    return respond(engineIo.handleRequest(req, server)).then((res) => {
                        // Access log for the Socket.IO upgrade path (handled outside Hono) —
                        // same Caddy-compatible structure as the API access log
                        const remote: any = (server as any).requestIP?.(req);
                        const remoteIp = remote?.address ?? null;
                        const remotePort = remote?.port ?? null;
                        logger.info(`${req.method} ${url.pathname}${url.search} → ${res.status}`, {
                            logger: 'http.log.access',
                            status: res.status,
                            duration: Math.round((performance.now() - start) * 10) / 10,
                            method: req.method,
                            uri: url.pathname + url.search,
                            remote_ip: remoteIp,
                            bytes_read: Number(req.headers.get('content-length')) || 0,
                            size: Number(res.headers.get('content-length')) || 0,
                            user_id: '',
                            ip: remoteIp ?? 'unknown',
                            traceId: null,
                            tenant: null,
                            request: {
                                headers: collectHeaders(req.headers),
                                client_ip: remoteIp ?? 'unknown',
                                host: req.headers.get('host') ?? '',
                                method: req.method,
                                remote_ip: remoteIp,
                                remote_port: remotePort,
                                uri: url.pathname + url.search,
                            },
                            resp_headers: collectHeaders(res.headers),
                        });
                        return res;
                    });
                }
                return respond(app.fetch(req, server));
            },
            websocket: websocket,
            maxRequestBodySize: 1024 * 1024 * 100, // 100MB
        })

        // Register server for built-in metrics (GET /health)
        registerMetrics(server);

        // Graceful shutdown: release the port & DB connections so restarts
        // (e.g. bun --watch) never hit a zombie / EADDRINUSE
        const shutdownServer = (signal: string) => {
            console.log(`\n${signal} received — shutting down…`.gray);
            try { server.stop(true); } catch {}
            for (const tenant of cfg.tenants ?? []) {
                try { tenant.database?.client?.close(); } catch {}
            }
            process.exit(0);
        };
        process.once('SIGINT', () => shutdownServer('SIGINT'));
        process.once('SIGTERM', () => shutdownServer('SIGTERM'));

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

        // Boot event — recorded in the log file only (the console banner already
        // shows name / PID / role / URL, so this line would be redundant on screen)
        logger.file('Server started', {
            name: NAME,
            pid: process.pid,
            role,
            url: `http://localhost:${PORT}`,
            env: env || 'dev',
            logFile: logger.filePath || undefined,
        });

        // Uncaught errors → log file (MongoDB-style), then exit
        process.on('uncaughtException', (err) => {
            logger.error('Uncaught exception', { message: err?.message, stack: err?.stack });
            process.exit(1);
        });
        process.on('unhandledRejection', (reason: any) => {
            logger.error('Unhandled rejection', { message: reason?.message ?? String(reason), stack: reason?.stack });
        });

        return server;
    } catch (err: any) {
        logger.error('Failed to boot server', cfg.debug ? { error: err, message: err?.message } : { message: err?.message });
        console.error('Failed to boot server', cfg.debug ? err : err?.message);
        process.exit(1);
    }
}

export {
    bootApp
}
