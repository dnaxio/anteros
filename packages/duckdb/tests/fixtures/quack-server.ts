/**
 * A Quack server, in its **own process** — spawned by the test suite.
 *
 * The remote tests talk to it over the protocol, and the server's native thread
 * never runs inside the test process: a native crash of the engine then cannot
 * take the whole suite down with it (and the tests exercise the same code path a
 * real deployment does).
 */
import { DuckdbQuackServer } from "../../index";

const port = Number(Bun.env.QUACK_TEST_PORT);
const token = Bun.env.QUACK_TEST_TOKEN ?? "";
if (!Number.isInteger(port) || !token) {
    console.error("QUACK_TEST_PORT and QUACK_TEST_TOKEN are required");
    process.exit(2);
}

const server = new DuckdbQuackServer({ port, token });
await server.start();
await server.db.exec("CREATE TABLE hello AS SELECT 'world' AS s");

// The parent scans stdout for this line, then attaches.
console.log(`READY ${server.url}`);

let stopping = false;
const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop().catch(() => {});
    process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// Nothing else keeps the event loop alive: the Quack listener is a native thread.
setInterval(() => {}, 60_000);
