// {{name}} — Anteros server entrypoint.
//
// The boot configuration lives in `config/app.ts`; run the server with:
//   bun run dev      # watch mode
//   bun run start    # plain run

import { app } from "@anteros/core"
import config from "./config/app"

await app.boot(config)
