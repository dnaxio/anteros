
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
import { loadTenantsMiddlewares } from '../lib/middleware'
import crypto from 'node:crypto';

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
        const useClusterMode = cfg.clusterMode || false;
        const env = process.env.NODE_ENV || Bun.env.NODE_ENV || 'dev';
        // reusePort: cluster mode ON by default, dev mode OFF to detect zombies
        const reusePort = cfg.server.reusePort ?? (useClusterMode && env !== 'dev');

        // Detect zombie: check if port is already in use in dev mode
        if (!reusePort && env === 'dev') {
            const occupied = await isPortInUse(PORT);
            if (occupied) {
                console.error(`\n⚠ Port ${PORT} is already in use. Possible zombie server.\n  → Kill it: lsof -ti :${PORT} | xargs kill -9\n  → Or set server.reusePort: true in config\n`.red.bold);
                process.exit(1);
            }
        }


        const app = createApp();

        const server = Bun.serve({
            port: PORT,
            reusePort,
            fetch: (req, server) => {
                const url = new URL(req.url);

                if (url.pathname === "/socket.io/") {
                    return engineIo.handleRequest(req, server);
                } else {
                    return app.fetch(req, server);
                }

            },
            websocket: websocket,
            maxRequestBodySize: 1024 * 1024 * 100, // 100MB
        })

        let box = '';
        box += `${NAME}`.gray.underline + ` (PID: ${process.pid})\n\n`
        box += `Env: ${env || 'dev'}`.green.bold + '\n'
        box += `Cluster mode: ${useClusterMode ? 'On'.green.bold : 'Off'.red.bold}\n`.gray.bold
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
