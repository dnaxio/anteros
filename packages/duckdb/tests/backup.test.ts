import { describe, it, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DuckdbQuackInstance, DuckdbQuackServer, DuckdbQuackError } from "../index";
import { freePort, sleep } from "./helpers";

/**
 * Snapshots of the database file — the manual clone and export, the rotation, the
 * refusals, and the server's schedule.
 *
 * Every case works under its own `mkdtemp` directory, and releases what it opened
 * in `finally`: a file lock left behind makes the next case fail for the wrong
 * reason.
 */

/** The names a backup directory currently holds. */
async function snapshots(directory: string): Promise<string[]> {
    return (await readdir(directory)).sort();
}

describe("@anteros/duckdb — backups", () => {
    it("clones an open database file that a second instance can query", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-backup-"));
        const db = new DuckdbQuackInstance({ dbPath: join(directory, "app.duckdb") });
        try {
            await db.exec("CREATE TABLE orders (id INTEGER, total INTEGER)");
            await db.exec("INSERT INTO orders VALUES (1, 10), (2, 20), (3, 30)");

            const snapshot = await db.backup({ directory: join(directory, "backups") });

            expect(snapshot.format).toBe("file");
            expect(snapshot.path.endsWith(".duckdb")).toBe(true);
            expect(basename(snapshot.path).startsWith("app-")).toBe(true);
            expect(basename(snapshot.path)).toMatch(/^app-\d{8}T\d{6}Z\.duckdb$/);
            expect(await snapshots(join(directory, "backups"))).toEqual([basename(snapshot.path)]);

            // The point of a clone: another instance opens it and sees the rows.
            const clone = new DuckdbQuackInstance({ dbPath: snapshot.path });
            try {
                const { rows } = await clone.exec("SELECT count(*) AS n FROM orders");
                expect(Number(rows[0]!.n)).toBe(3);
            } finally {
                await clone.close();
            }
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 30_000);

    it("exports the database as Parquet with schema.sql and load.sql", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-backup-export-"));
        const db = new DuckdbQuackInstance({ dbPath: join(directory, "app.duckdb") });
        try {
            await db.exec("CREATE TABLE orders (id INTEGER, total INTEGER)");
            await db.exec("INSERT INTO orders VALUES (1, 10), (2, 20)");

            const snapshot = await db.backup({
                directory: join(directory, "backups"),
                format: "export",
            });

            expect(snapshot.format).toBe("export");
            expect(snapshot.path.endsWith(".export")).toBe(true);

            const files = await readdir(snapshot.path);
            expect(files).toContain("schema.sql");
            expect(files).toContain("load.sql");
            expect(files.some((name) => name.endsWith(".parquet"))).toBe(true);
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 30_000);

    it("keeps only the requested number of snapshots", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-backup-rotate-"));
        const db = new DuckdbQuackInstance({ dbPath: join(directory, "app.duckdb") });
        const backups = join(directory, "backups");
        try {
            await db.exec("CREATE TABLE orders (id INTEGER)");
            await db.exec("INSERT INTO orders VALUES (1)");

            const written: string[] = [];
            for (let index = 0; index < 3; index += 1) {
                if (index > 0) await sleep(1_100);
                const snapshot = await db.backup({ directory: backups, keep: 2 });
                written.push(basename(snapshot.path));
            }

            // Three snapshots, the oldest rotated away — the stamp sorts.
            expect(await snapshots(backups)).toEqual(written.slice(1).sort());
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 30_000);

    it("refuses a file backup without a dbPath, and exports an in-memory database", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-backup-memory-"));
        const db = new DuckdbQuackInstance();
        try {
            await db.exec("CREATE TABLE events (id INTEGER)");
            await db.exec("INSERT INTO events VALUES (1), (2)");

            const refusal = await db.backup({ directory }).catch((err: unknown) => err);
            expect(refusal).toBeInstanceOf(DuckdbQuackError);
            expect((refusal as DuckdbQuackError).code).toBe("DUCKDB_BACKUP_REQUIRES_DBPATH");

            const snapshot = await db.backup({ directory, format: "export" });
            expect(snapshot.format).toBe("export");
            expect(await readdir(snapshot.path)).toContain("schema.sql");
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
    }, 30_000);

    it("snapshots the server on a schedule, and stops after stop()", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-backup-server-"));
        const backups = join(directory, "backups");
        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "backup-token",
            dbPath: join(directory, "app.duckdb"),
            backup: { directory: backups, onStart: true, every: "1s", keep: 2 },
        });
        try {
            await server.start();
            await server.db.exec("CREATE TABLE events (id INTEGER)");
            await server.db.exec("INSERT INTO events VALUES (1), (2)");

            // The first snapshot is the `onStart` one; the next ticks rotate.
            await sleep(2_600);
            const names = await snapshots(backups);
            expect(names).toHaveLength(2);
            expect(names.every((name) => /^app-\d{8}T\d{6}Z\.duckdb$/.test(name))).toBe(true);

            // A manual snapshot goes through `server.db`, with the overrides merged
            // over the configured schedule.
            const manual = await server.backup({ directory: join(directory, "manual") });
            expect(manual.format).toBe("file");
            expect(await snapshots(join(directory, "manual"))).toHaveLength(1);

            // An attached client has no file of its own to clone.
            const client = new DuckdbQuackInstance({ url: server.url, token: "backup-token" });
            try {
                const refusal = await client.backup({ directory }).catch((err: unknown) => err);
                expect(refusal).toBeInstanceOf(DuckdbQuackError);
                expect((refusal as DuckdbQuackError).code).toBe("DUCKDB_BACKUP_REMOTE");
            } finally {
                await client.close();
            }

            await server.stop();
            await sleep(1_500);
            expect(await snapshots(backups)).toEqual(names);
        } finally {
            await server.stop();
            await rm(directory, { recursive: true, force: true });
        }
    }, 60_000);
});
