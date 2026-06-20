import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import { useRest } from "../database/rest"
import { io } from "../server/io"
import type { WebSocketHandler } from "../types/websocket"


async function loadSockets() {
    try {
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const SOCKETS_PATH = path.join(TENANT_PATH, 'sockets')
            const exist = await fs.exists(SOCKETS_PATH)
            if (!exist) continue
            const isDirectory = await (await fs.stat(SOCKETS_PATH)).isDirectory()
            if (!isDirectory) continue

            const glob = new Glob(path.join(SOCKETS_PATH, '**/*.ws.ts'))
            for await (let file of glob.scan('.')) {
                const socketModule = await import(file)
                const handler = socketModule?.default as WebSocketHandler | undefined

                if (handler?._isWebSocket_ && handler.enabled) {
                    const rest = new useRest({ tenant_id: tenant.id })

                    io.on('connection', (socket) => {
                        handler.exec({ io, rest, socket })
                    })

                    console.log(`[socket] ${tenant.id}/${path.basename(file, '.ws.ts')} loaded`)
                }
            }
        }

    } catch (err: any) {
        console.error('[socket] Failed to load sockets:', err?.message)
    }
}

export {
    loadSockets
}
