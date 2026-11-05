import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The landing badge shows the version of `@anteros/core` actually in the monorepo,
 * so a release can never leave a stale `vX.Y.Z` on the home page.
 */
const coreVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../packages/core/package.json", import.meta.url)), "utf8"),
).version as string;

export default defineNuxtConfig({
  extends: ["@baybreezy/docd"],

  runtimeConfig: {
    public: { coreVersion },
  },

  site: {
    name: "Anteros",
    description:
      "Anteros Framework documentation — the all-in-one backend framework for Bun and MongoDB.",
  },
  /**
   * OG image rendering (`nuxt-og-image`).
   *
   * `nuxt generate` renders one image per page through a single serialised
   * renderer: the first render pays the cold start (renderer + font loading) and
   * can overrun the 15 s default, which fails that route during prerendering with
   * `408 — Request timed out while waiting for OG image render`. A prerender has no
   * user waiting on it, so the budget is raised rather than the feature dropped.
   */
  ogImage: {
    security: {
      renderTimeout: 60_000,
    },
  },
  llms: {
    domain: process.env.NUXT_SITE_URL || "http://localhost:3000",
    title: "Anteros Framework",
    description:
      "Anteros Framework documentation — the all-in-one backend framework for Bun and MongoDB.",
    full: {
      title: "Anteros Framework",
      description:
        "Anteros Framework documentation — the all-in-one backend framework for Bun and MongoDB.",
    },
  },
});
