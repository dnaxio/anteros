export default defineNuxtConfig({
  extends: ["@baybreezy/docd"],
  site: {
    name: "Anteros",
    description:
      "Anteros Framework documentation — the all-in-one backend framework for Bun and MongoDB.",
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
