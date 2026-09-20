/**
 * Fixture — boots the server through `bootApp`, to be launched with a boot mode
 * flag (see `packages/core/tests/replication-only.test.ts`).
 * Port and database URIs are overridable through the environment so the same
 * fixture serves every mode without clashes.
 *
 * Run manually:
 *   bun packages/core/tests/fixtures/repl-only/app.ts --replication-only
 *   bun packages/core/tests/fixtures/repl-only/app.ts --no-replication
 */
import { bootApp } from "../../../server/boot";

await bootApp({
    server: { port: Number(Bun.env.RO_PORT ?? 5556) },
    tenants: [{
        id: "ro",
        dir: "packages/core/tests/fixtures/repl-only/tenant",
        database: { uri: Bun.env.RO_SRC ?? "mongodb://localhost:27017/_RO_SRC" },
        replication: {
            enabled: true,
            runOnBoot: true,
            schedule: { interval: "1h" },
            destinations: [{ id: "backup", uri: Bun.env.RO_DST ?? "mongodb://localhost:27017/_RO_DST" }],
        },
    }],
});
