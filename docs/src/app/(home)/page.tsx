import Link from "next/link";
import {
  ZapIcon,
  DatabaseIcon,
  ShieldCheckIcon,
  WorkflowIcon,
  Building2Icon,
  ScrollTextIcon,
  ArrowRightIcon,
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center text-center flex-1 px-4 py-16">
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl md:text-6xl mb-6">
        Anteros Framework
      </h1>
      <p className="max-w-2xl text-lg text-fd-muted-foreground mb-8">
        A robust backend server built on <strong>Bun</strong> and{" "}
        <strong>MongoDB</strong> with multi-tenant architecture, unified REST
        API, JWT authentication, hooks, file uploads, workflow engine, and more.
      </p>

      <div className="flex flex-wrap gap-4 mb-16">
        <Link
          href="/docs/getting-started/quick-start"
          className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-6 py-3 text-sm font-medium text-fd-primary-foreground hover:bg-fd-primary/90 transition-colors"
        >
          Quick Start
          <ArrowRightIcon className="size-4" />
        </Link>
        <Link
          href="/docs/getting-started/introduction"
          className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium hover:bg-fd-accent transition-colors"
        >
          Introduction
        </Link>
        <Link
          href="/docs/reference/configuration"
          className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium hover:bg-fd-accent transition-colors"
        >
          Configuration
        </Link>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl w-full text-left">
        <div className="rounded-lg border p-6">
          <ZapIcon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">Blazing Fast</h3>
          <p className="text-sm text-fd-muted-foreground">
            Powered by Bun, one of the fastest JavaScript runtimes available.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <DatabaseIcon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">MongoDB</h3>
          <p className="text-sm text-fd-muted-foreground">
            Full database integration with automatic schema validation and
            indexing.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <ShieldCheckIcon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">Security</h3>
          <p className="text-sm text-fd-muted-foreground">
            JWT authentication, access control, rate limiting, IP restriction.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <WorkflowIcon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">Workflows</h3>
          <p className="text-sm text-fd-muted-foreground">
            Sequential step execution with compensation, versioning, and
            progress tracking.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <Building2Icon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">Multi-Tenant</h3>
          <p className="text-sm text-fd-muted-foreground">
            Isolated databases and code roots per tenant, with scoped
            collections, routes, and services.
          </p>
        </div>
        <div className="rounded-lg border p-6">
          <ScrollTextIcon className="size-8 mb-3 text-fd-primary" />
          <h3 className="font-semibold mb-1">Audit Trail</h3>
          <p className="text-sm text-fd-muted-foreground">
            Automatic activity logging for every operation with trace
            correlation and collection-type tracking.
          </p>
        </div>
      </div>

      <p className="mt-12 text-sm text-fd-muted-foreground">
        Powered by{" "}
        <a
          href="https://dnax.io"
          className="font-medium underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          Dnax Inc.
        </a>
      </p>
    </div>
  );
}
