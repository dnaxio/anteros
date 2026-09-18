import { define } from "@anteros/core"

/**
 * Custom HTTP route — served at `GET /api/v1/healthz`
 * (tenant `{{tenant}}` + the `/api/v1` prefix from `config/app.ts`).
 */
export default define.Route({
  enabled: true,
  method: "GET",
  path: "/healthz",

  handler: ({ c }) =>
    c.json({
      status: "ok",
      tenant: "{{tenant}}",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
})
