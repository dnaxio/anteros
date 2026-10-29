import { DuckdbQuackServer } from "../../index";

/**
 * A server started with **no keep-alive of its own** — the library must hold the
 * Bun process open (the Quack listener is a native thread, invisible to the
 * event loop). The test spawns this file, waits, and checks it is still running.
 */
const port = Number(Bun.env.QUACK_TEST_PORT);
const token = Bun.env.QUACK_TEST_TOKEN ?? "";

const server = new DuckdbQuackServer({ port, token });
await server.start();

console.log(`READY ${server.url}`);
