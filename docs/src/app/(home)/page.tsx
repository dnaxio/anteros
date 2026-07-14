import Link from "next/link";
import { Bun, MongodbIcon } from "@dev.icons/react/mono";

export default function HomePage() {
  return (
    <main className="flex-1">
      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,var(--color-fd-primary)_0%,transparent_50%)] opacity-[0.07]" />
        <div className="relative mx-auto max-w-5xl px-6 py-24 md:py-36 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-fd-primary/30 bg-fd-primary/10 px-4 py-1.5 text-sm font-medium text-fd-primary mb-8">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-fd-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-fd-primary" />
            </span>
            v0.0.11 — Now available
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl mb-6">
            Build backends
            <span className="block text-fd-primary">at light speed.</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-fd-muted-foreground mb-10 leading-relaxed">
            A robust backend for building business logic —{" "}
            <Bun size={20} className="inline align-text-bottom mx-0.5" />{" "}
            <strong>Bun</strong> runtime,{" "}
            <MongodbIcon size={20} className="inline align-text-bottom mx-0.5" />{" "}
            <strong>MongoDB</strong> database, multi-tenant architecture,
            real-time <strong>Socket.IO</strong>, built-in <strong>caching</strong>, symmetric & asymmetric <strong>crypto</strong>,
            workflow engine, file management, and audit trail. All in one.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/docs/getting-started/quick-start"
              className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-7 py-3.5 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 hover:bg-fd-primary/90 hover:shadow-fd-primary/40 transition-all duration-200"
            >
              Get Started
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3.333 8h9.334M8 3.333 12.667 8 8 12.667" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <Link
              href="/docs/getting-started/introduction"
              className="inline-flex items-center gap-2 rounded-xl border px-7 py-3.5 text-sm font-semibold hover:bg-fd-accent transition-colors duration-200"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>

      {/* Feature cards x3 */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          <div className="group rounded-xl border bg-fd-card p-8 hover:border-fd-primary/50 hover:shadow-lg transition-all duration-300">
            <div className="mb-4 inline-flex rounded-lg bg-fd-primary/10 p-3">
              <Bun size={24} />
            </div>
            <h3 className="font-semibold text-lg mb-2">Bun Runtime</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Blazing fast APIs powered by Bun — one of the fastest JavaScript runtimes. Zero-config hot reload and native TypeScript support.
            </p>
          </div>
          <div className="group rounded-xl border bg-fd-card p-8 hover:border-fd-primary/50 hover:shadow-lg transition-all duration-300">
            <div className="mb-4 inline-flex rounded-lg bg-fd-primary/10 p-3">
              <MongodbIcon size={24} />
            </div>
            <h3 className="font-semibold text-lg mb-2">MongoDB Native</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Full database integration with automatic schema validation, indexing, aggregation pipelines, and change streams out of the box.
            </p>
          </div>
          <div className="group rounded-xl border bg-fd-card p-8 hover:border-fd-primary/50 hover:shadow-lg transition-all duration-300">
            <div className="mb-4 inline-flex rounded-lg bg-fd-primary/10 p-3">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
            </div>
            <h3 className="font-semibold text-lg mb-2">Multi-Tenant</h3>
            <p className="text-sm text-fd-muted-foreground leading-relaxed">
              Isolated databases, per-tenant code folders, scoped collections, routes, services, and middlewares. One server, infinite tenants.
            </p>
          </div>
        </div>
      </section>

      {/* Everything you need */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <div className="text-center mb-12">
          <h2 className="text-2xl font-bold tracking-tight mb-3">Everything you need.</h2>
          <p className="text-fd-muted-foreground max-w-xl mx-auto">
            Batteries included. No stitching together disparate tools.
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
              title: "Security",
              desc: "JWT, access control, rate limiting, IP restriction.",
            },
            {
              icon: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>,
              title: "Crypto",
              desc: "AES-256-GCM symmetric & RSA-OAEP asymmetric encryption out of the box.",
            },
            {
              icon: <><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="12" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M9 6h6M9 18h6M6 9v6M18 9v6M9 9l6 6M15 9l-6 6"/></>,
              title: "Socket.IO",
              desc: "Real-time WebSocket communication with room support and built-in auth.",
            },
            {
              icon: <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></>,
              title: "Caching",
              desc: "In-memory, filesystem, and Redis caching with TTL, grace periods, and stampede protection.",
            },
            {
              icon: <><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></>,
              title: "File Upload",
              desc: "Disk/S3 storage, image transforms, multi-destination replication.",
            },
            {
              icon: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>,
              title: "Hooks & Actions",
              desc: "Lifecycle hooks, custom actions, services, before/after operations.",
            },
            {
              icon: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></>,
              title: "Workflows",
              desc: "Saga pattern, compensation, progress tracking, resume on failure.",
            },
            {
              icon: <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></>,
              title: "Business Logic",
              desc: "Services, scripts, and custom actions to encapsulate your domain logic cleanly.",
            },
          ].map(({ icon, title, desc }) => (
            <div key={title} className="rounded-xl border bg-fd-card p-6 hover:bg-fd-accent/50 transition-colors duration-200">
              <div className="mb-3 text-fd-primary">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
              </div>
              <h3 className="font-semibold text-sm mb-1">{title}</h3>
              <p className="text-xs text-fd-muted-foreground">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t">
        <div className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h2 className="text-2xl font-bold tracking-tight mb-3">Ready to build?</h2>
          <p className="text-fd-muted-foreground mb-8 max-w-lg mx-auto">
            Create your first Anteros project in seconds.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/docs/getting-started/quick-start"
              className="inline-flex items-center gap-2 rounded-xl bg-fd-primary px-6 py-3 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/25 hover:shadow-fd-primary/40 transition-all duration-200"
            >
              Quick Start
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3.333 8h9.334M8 3.333 12.667 8 8 12.667" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <Link
              href="/docs/reference/configuration"
              className="inline-flex items-center gap-2 rounded-xl border px-6 py-3 text-sm font-semibold hover:bg-fd-accent transition-colors duration-200"
            >
              Explore the docs
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t">
        <div className="mx-auto max-w-5xl px-6 py-8 text-center text-sm text-fd-muted-foreground">
          Powered by{" "}
          <a href="https://dnax.io" className="font-medium underline" target="_blank" rel="noopener noreferrer">
            Dnax Inc.
          </a>
        </div>
      </footer>
    </main>
  );
}
