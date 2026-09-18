# Anteros Documentation

Documentation site for the **Anteros Framework**, built with [Nuxt Content](https://content.nuxt.com) on top of the [`@baybreezy/docd`](https://docd.uithing.com) layer.

## Development

```bash
ni          # install dependencies (bun install)
nr dev      # start the dev server on http://localhost:3000
nr build    # production build (SSR server)
nr generate # statically generate the docs
```

## Content

All content lives in `content/` as Markdown + [MDC](https://content.nuxt.com/docs/files/markdown) syntax:

```
content/
├── index.md                     # Landing page (/)
└── docs/                        # Everything under /docs
    ├── index.md                 # Overview (/docs)
    ├── 01.getting-started/      # Numeric prefixes control the sidebar order
    ├── 02.reference/
    ├── 03.query-language/
    ├── 04.manage-data/
    ├── 05.cli/
    └── 06.packages/
```

Rules of thumb:

- **Ordering** — the sidebar follows the file/folder names, sorted alphabetically. Numeric prefixes (`01.`, `02.`, …) set the order and are stripped from the URL, so `02.reference/04.fields.md` is served at `/docs/reference/fields`.
- **Section labels** — a `.navigation.yml` file in a folder sets its `title` and `icon` (an [Icônes](https://icones.js.org) name, e.g. `lucide:rocket`).
- **Page metadata** — frontmatter `title`, `description` and `navigation.icon`. Never add an H1: the title is rendered from the frontmatter.
- **Cross-links** — use absolute paths such as `/docs/reference/fields`.

### Useful MDC components

| Component                                                       | Purpose                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `::prose-callout{variant="info" title="…"}`                     | Admonitions (`info`, `success`, `warning`, `error`, `tip`, `note`, `example`) |
| `::prose-steps` / `::prose-step`                                | Numbered procedures                                                           |
| `::prose-code-group`                                            | Tabbed code blocks, synced across the page                                    |
| `::prose-collapsible{openTitle="…"}`                            | Collapsed long-form example                                                   |
| `::prose-card{icon="lucide:zap" title="…" to="/docs/…"}`        | Link card                                                                     |
| `::prose-pm-install{name="…"}` / `::prose-pm-run{script="dev"}` | Package-manager aware command blocks                                          |

Code fences can display a file name with Shiki's bracket notation:

````md
```typescript [server.ts]
console.log("hello");
```
````

## Configuration

- `nuxt.config.ts` — site name/description, LLM files (`llms.txt`, `llms-full.txt`).
- `app/app.config.ts` — header title, GitHub "Edit this page" link, sidebar expansion, extra links, borders and page transitions.
- `app/components/content/` — project-local MDC components used by the landing page (`LandingFeatures`, `LandingCta`).

Full layer options: [docd.uithing.com](https://docd.uithing.com).
