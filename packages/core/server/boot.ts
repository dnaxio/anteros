
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


        const PORT = (cfg.server.port || 4000);
        const NAME = cfg.server.name || process.env.APP_NAME || 'SERVER';
        const useClusterMode = cfg.clusterMode || false;
        const env = process.env.NODE_ENV || Bun.env.NODE_ENV || 'dev';


        const app = createApp();

        const server = Bun.serve({
            port: PORT,
            reusePort: useClusterMode,
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
        console.error('Failed to boot server', err?.message);
        process.exit(1);
    }
}

export {
    bootApp
}
