import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Server as SocketServer } from "socket.io";
import { Server as Engine } from "@socket.io/bun-engine";
import { Anteros, Rest, AnterosSocket, SocketEmitter } from "../index";

/**
 * The SDK's **socket** surface — `client.socket(namespace?, options?)` and every
 * Socket.IO client method, against a real server (the same `socket.io` + Bun
 * engine pair a tenant runs).
 */

let io: SocketServer;
let engine: Engine;
let server: any;
let base = "";

const sockets: AnterosSocket[] = [];
/** Every `room:join` received — `(socket id, room, probe header)`. */
const joins: Array<{ id: string; room: string; probe: string }> = [];

/** A socket that is closed in `afterEach` — no test leaks a connection. */
function socketOf(client: Anteros | Rest, namespace?: string, options?: Record<string, any>): AnterosSocket {
    const socket = client.socket(namespace, options as any);
    sockets.push(socket);
    return socket;
}

beforeAll(() => {
    io = new SocketServer({ cors: { origin: "*" } });
    engine = new Engine();
    io.bind(engine);
    const { websocket } = engine.handler();

    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        websocket,
        fetch: (req, srv) => engine.handleRequest(req, srv),
    });
    base = `http://127.0.0.1:${server.port}`;

    io.on("connection", (socket) => {
        const probe = String(socket.handshake.headers["x-probe"] ?? "");
        socket.emit("welcome", { id: socket.id, auth: socket.handshake.auth, probe });
        socket.on("room:join", (room, ack) => {
            joins.push({ id: socket.id, room, probe });
            ack?.({ ok: true });
        });
        socket.on("echo", (data, ack) => ack?.({ ...data, tenant: socket.handshake.auth?.tenant }));
        socket.on("sum", (a, b, ack) => ack?.(Number(a) + Number(b)));
        socket.on("broadcast", (message) => io.emit("broadcast", message));
        socket.on("message", (message) => socket.emit("message", message));
        socket.on("ping-me", (_data, ack) => ack?.({ pong: true }));
        // `no-ack` deliberately never acknowledges
    });

    io.of("/chat").on("connection", (socket) => {
        socket.emit("chat:welcome", { auth: socket.handshake.auth, ns: socket.nsp.name });
    });
});

afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    joins.length = 0;
    await Bun.sleep(10);
});

afterAll(() => {
    try { io.close(); } catch { /* already closed */ }
    try { server?.stop(true); } catch { /* already stopped */ }
});

describe("client.socket() — the connection", () => {
    it("connects with the tenant and the token in `auth`", async () => {
        const api = new Anteros({ server: base, tenant: "v1", token: { persist: false } });
        api.setToken("secret-token");
        const socket = socketOf(api);

        const welcome: any = await socket.waitFor("welcome", 5_000);
        expect(welcome.auth).toEqual({ tenant: "v1", token: "secret-token" });

        expect(socket.connected).toBe(true);
        expect(socket.disconnected).toBe(false);
        expect(socket.id).toBe(welcome.id);
        expect(socket.active).toBe(true);
        expect(socket.url).toBe(base);
        expect(socket.raw.connected).toBe(true);
    });

    it("passes `auth` claims over the defaults, and `timeoutMs` to the acks", async () => {
        const api = new Rest({ server: base, tenant: "v1", token: { persist: false } });
        const socket = socketOf(api, "/", { auth: { role: "admin" }, timeoutMs: 150 });

        const welcome: any = await socket.waitFor("welcome", 5_000);
        expect(welcome.auth).toMatchObject({ tenant: "v1", role: "admin" });

        // The default ack deadline applies to `emitWithAck`
        await expect(socket.emitWithAck("no-ack")).rejects.toThrow(/timed out|timeout/i);
    });

    it("connects to a namespace", async () => {
        const api = new Anteros({ server: base, tenant: "v1", token: { persist: false } });
        const chat = socketOf(api, "/chat");
        expect(chat.url).toBe(`${base}/chat`);

        const welcome: any = await chat.waitFor("chat:welcome", 5_000);
        expect(welcome.ns).toBe("/chat");
        expect(welcome.auth.tenant).toBe("v1");
    });

    it("reconnects with the new auth after `setToken` / `setAuth`", async () => {
        const api = new Anteros({ server: base, tenant: "v1", token: { persist: false } });
        const socket = socketOf(api, "/", { auth: { token: "first" } });
        await socket.waitFor("welcome", 5_000);

        const next = socket.waitFor("welcome", 5_000);
        socket.setToken("second");
        expect(((await next) as any).auth.token).toBe("second");

        const merged = socket.waitFor("welcome", 5_000);
        socket.setAuth({ role: "ops" });
        const welcome: any = await merged;
        expect(welcome.auth).toMatchObject({ token: "second", role: "ops", tenant: "v1" });
        expect(socket.auth).toMatchObject({ token: "second", role: "ops" });
    });
});

describe("client.socket() — listening", () => {
    it("on / once / off / listeners / hasListeners / removeAllListeners", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        const seen: string[] = [];
        const listener = (value: string) => seen.push(value);
        socket.on("broadcast", listener);
        socket.once("broadcast", (value: string) => seen.push(`once:${value}`));

        expect(socket.hasListeners("broadcast")).toBe(true);
        expect(socket.listenerCount("broadcast")).toBe(2);
        expect(socket.listeners("broadcast")).toHaveLength(2);

        socket.emit("broadcast", "a");
        await socket.waitFor("broadcast", 2_000).catch(() => {});
        socket.emit("broadcast", "b");
        await Bun.sleep(80);

        expect(seen).toEqual(["a", "once:a", "b"]); // `once` ran on the first only

        socket.off("broadcast", listener);
        expect(socket.listenerCount("broadcast")).toBe(0);
        socket.emit("broadcast", "c");
        await Bun.sleep(80);
        expect(seen).toEqual(["a", "once:a", "b"]);

        socket.removeAllListeners();
        expect(socket.hasListeners("broadcast")).toBe(false);
    });

    it("onConnect / onDisconnect / onConnectError", async () => {
        // The listeners must exist **before** the handshake: no auto-connect
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }),
            "/", { autoConnect: false });
        const connected = new Promise<void>((resolve) => socket.onConnect(() => resolve()));
        socket.connect();
        await connected;

        const disconnected = new Promise<string>((resolve) => socket.onDisconnect((reason: string) => resolve(reason)));
        socket.disconnect();
        expect(await disconnected).toBe("io client disconnect");
        expect(socket.connected).toBe(false);
        expect(socket.disconnected).toBe(true);

        // The server is not listening on this port
        const broken = socketOf(new Anteros({ server: "http://127.0.0.1:1", tenant: "v1", token: { persist: false } }),
            "/", { autoConnect: false, reconnection: false });
        const error = new Promise<string>((resolve) => broken.onConnectError((err: Error) => resolve(err.message)));
        broken.connect();
        expect(await error).toBeDefined();
    });

    it("onAny / offAny / onAnyOutgoing / offAnyOutgoing / prependAny", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        const incoming: string[] = [];
        const anyListener = (event: string) => incoming.push(event);
        socket.onAny(anyListener);
        socket.prependAny((event: string) => incoming.push(`first:${event}`));

        socket.emit("broadcast", "x");
        await socket.waitFor("broadcast", 2_000).catch(() => {});
        expect(incoming).toContain("broadcast");
        expect(incoming.indexOf("first:welcome")).toBe(-1); // attached after the welcome

        socket.offAny(anyListener);
        socket.offAny(); // removes the prepended one
        incoming.length = 0;
        socket.emit("broadcast", "y");
        await Bun.sleep(80);
        expect(incoming).toEqual([]);

        const outgoing: string[] = [];
        socket.onAnyOutgoing((event: string) => outgoing.push(event));
        socket.emit("broadcast", "z");
        expect(outgoing).toContain("broadcast");
        socket.offAnyOutgoing();
        socket.emit("broadcast", "w");
        expect(outgoing).toEqual(["broadcast"]);
    });
});

describe("client.socket() — emitting", () => {
    it("emitWithAck round-trips a value, with the tenant", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        expect(await socket.emitWithAck<number>("sum", 2, 3)).toBe(5);
        expect(await socket.emitWithAck("echo", { hello: "world" })).toEqual({ hello: "world", tenant: "v1" });
        expect(await socket.emitWithAck("ping-me", {})).toEqual({ pong: true });
    });

    it("timeout() gives the ack a deadline; volatile and compress still emit", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        const quick = socket.timeout(120);
        expect(quick).toBeInstanceOf(SocketEmitter);
        await expect(quick.emitWithAck("no-ack")).rejects.toThrow(/timed out|timeout/i);

        const got = socket.waitFor("broadcast", 2_000);
        socket.volatile.emit("broadcast", "volatile");
        expect(await got).toBe("volatile");

        const compressed = socket.waitFor("broadcast", 2_000);
        socket.compress(true).emit("broadcast", "compressed");
        expect(await compressed).toBe("compressed");
    });

    it("send() uses the `message` event", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        const message = socket.waitFor("message", 2_000);
        socket.send("hello");
        expect(await message).toBe("hello");
    });

    it("waitFor rejects with SOCKET_TIMEOUT when the event never comes", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);
        await expect(socket.waitFor("never", 60)).rejects.toMatchObject({ code: "SOCKET_TIMEOUT" });
    });
});

describe("client.socket() — connection controls", () => {
    it("disconnect / connect / reconnect", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        socket.disconnect();
        expect(socket.connected).toBe(false);

        const back = socket.waitFor("welcome", 5_000);
        socket.connect();
        await back;
        expect(socket.connected).toBe(true);

        const again = socket.waitFor("welcome", 5_000);
        socket.reconnect();
        await again;
        expect(socket.connected).toBe(true);

        socket.close(); // alias
        expect(socket.connected).toBe(false);
        socket.open(); // alias
        await socket.waitFor("welcome", 5_000);
        expect(socket.connected).toBe(true);
    });

    it("exposes the reconnection manager", async () => {
        const socket = socketOf(new Anteros({ server: base, tenant: "v1", token: { persist: false } }));
        await socket.waitFor("welcome", 5_000);

        expect(typeof socket.io.reconnection).toBe("boolean");
        expect(socket.io.raw).toBeDefined();
        const attempts: string[] = [];
        socket.io.on("reconnect_attempt", () => attempts.push("attempt"));
        socket.io.off("reconnect_attempt");
        socket.io.open();
        expect(attempts).toEqual([]);
    });
});

describe("client.socket() — rooms, token and headers (1–5)", () => {
    const client = () => new Anteros({ server: base, tenant: "v1", token: { persist: false } });

    it("re-joins the declared rooms on every connection, including a reconnection", async () => {
        const socket = socketOf(client(), "/", { rooms: ["alpha", "beta"] });
        const first: any = await socket.waitFor("welcome", 5_000);

        const until = async (n: number) => {
            const deadline = Date.now() + 2_000;
            while (joins.length < n && Date.now() < deadline) await Bun.sleep(20);
        };
        await until(2);
        expect(joins.map((join) => join.room)).toEqual(["alpha", "beta"]);
        expect(joins.every((join) => join.id === first.id)).toBe(true);
        expect(socket.rooms).toEqual(["alpha", "beta"]);

        joins.length = 0;
        const next = socket.waitFor("welcome", 5_000);
        socket.reconnect();
        await next;
        await until(2);
        expect(joins.map((join) => join.room)).toEqual(["alpha", "beta"]);
    });

    it("setRooms joins immediately and again on the next connection", async () => {
        const socket = socketOf(client());
        await socket.waitFor("welcome", 5_000);
        expect(joins).toEqual([]);

        socket.setRooms(["gamma"]);
        const deadline = Date.now() + 2_000;
        while (!joins.length && Date.now() < deadline) await Bun.sleep(20);
        expect(joins.map((join) => join.room)).toEqual(["gamma"]);

        joins.length = 0;
        const next = socket.waitFor("welcome", 5_000);
        socket.reconnect();
        await next;
        while (!joins.length && Date.now() < deadline) await Bun.sleep(20);
        expect(joins.map((join) => join.room)).toEqual(["gamma"]);
    });

    it("follows the client token — `login()` / `setToken()` / `clearToken()`", async () => {
        const api = client();
        api.setToken("first-token");
        const socket = socketOf(api);

        expect(((await socket.waitFor("welcome", 5_000)) as any).auth.token).toBe("first-token");

        const rotated = socket.waitFor("welcome", 5_000);
        api.setToken("second-token");
        expect(((await rotated) as any).auth.token).toBe("second-token");

        const cleared = socket.waitFor("welcome", 5_000);
        api.clearToken();
        expect(((await cleared) as any).auth.token).toBeUndefined();
    });

    it("reconnectWithHeaders rebuilds the transport, keeping the listeners", async () => {
        const socket = socketOf(client(), "/", { headers: { "X-Probe": "one" } });
        const seen: string[] = [];
        socket.on("welcome", (welcome: any) => seen.push(welcome.probe));

        const first: any = await socket.waitFor("welcome", 5_000);
        expect(first.probe).toBe("one");

        // The rebuild replaces the socket: wait on the new transport
        socket.reconnectWithHeaders({ "X-Probe": "two" });
        expect(((await socket.waitFor("welcome", 5_000)) as any).probe).toBe("two");
        expect(seen).toEqual(["one", "two"]);
    });

    it("waitForTimeoutMs is the default deadline", async () => {
        const socket = socketOf(client(), "/", { waitForTimeoutMs: 60 });
        await socket.waitFor("welcome", 5_000);
        await expect(socket.waitFor("never")).rejects.toMatchObject({ code: "SOCKET_TIMEOUT" });
        await expect(socket.waitFor("never", 90)).rejects.toThrow(/90ms/);
    });

    it("auth is a copy, and removeAllListeners(event) only clears that event", async () => {
        const socket = socketOf(client(), "/", { auth: { role: "ops" } });
        await socket.waitFor("welcome", 5_000);

        const copy = socket.auth;
        copy.role = "mutated";
        expect(socket.auth.role).toBe("ops");

        const seen: string[] = [];
        socket.on("broadcast", () => seen.push("broadcast"));
        socket.on("message", () => seen.push("message"));
        socket.removeAllListeners("broadcast");

        socket.emit("broadcast", "x");
        socket.send("y");
        await Bun.sleep(120);
        expect(seen).toEqual(["message"]);
    });

    it("accepts a typed listen map", async () => {
        type ServerEvents = {
            welcome: (payload: { id: string; auth: Record<string, any>; probe: string }) => void;
        };
        const typed = client().socket<ServerEvents>();
        sockets.push(typed as any);

        const promise = new Promise<string>((resolve) => {
            typed.on("welcome", (payload) => resolve(payload.id));
        });
        expect(typeof (await promise)).toBe("string");
    });
});
