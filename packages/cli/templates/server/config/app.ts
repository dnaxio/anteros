import { define } from "@anteros/core"

/**
 * Anteros boot configuration.
 *
 * `define.Server()` is a typed identity helper: it gives you autocompletion and
 * type-checking on the boot options. Docs: https://github.com/dnaxio/anteros
 */
export default define.Server({
  server: {
    name: "{{name}}",
    port: Number(Bun.env.PORT ?? {{port}}),

    // Wide-open CORS is fine while you are building. Restrict it before going public.
    cors: {
      origin: () => ["*"],
    },

    jwt: {
      // Set JWT_SECRET in .env — the value below is only a development fallback.
      secret: Bun.env.JWT_SECRET ?? "change-me",
    },

    logging: {
      level: "info",
    },
  },

  tenants: [
    {
      id: "{{tenant}}",
      name: "{{name}}",
      dir: "{{tenant}}",

      // `*.route.ts` files are only registered when a prefix is configured.
      routes: { prefix: "/api/v1" },

      database: {
        // Bun loads `.env` automatically, so MONGODB_URI wins over the fallback.
        uri: Bun.env.MONGODB_URI ?? "{{databaseUri}}",
      },
    },
  ],
})
