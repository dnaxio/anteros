export default defineAppConfig({
  docd: {
    github: {
      repo: "https://github.com/dnaxio/anteros",
      branch: "main",
      contentDir: "docd/content",
    },
    ui: {
      borderType: "dashed",
      header: {
        title: "Anteros",
      },
      toc: {
        title: "On this page",
        icon: "lucide:list",
      },
      transition: {
        name: "fade",
      },
      expandNav: 1,
      extraLinks: [
        {
          label: "GitHub",
          href: "https://github.com/dnaxio/anteros",
          icon: "simple-icons:github",
          external: true,
        },
        {
          label: "Issues",
          href: "https://github.com/dnaxio/anteros/issues",
          icon: "lucide:circle-dot",
          external: true,
        },
      ],
    },
  },
});
