import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";

const io = new Server();
const engineIo = new Engine();
io.bind(engineIo);
const { websocket } = engineIo.handler()



export {
    io,
    engineIo,
    websocket
}
