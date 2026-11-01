import type { AgentTraceEvent } from "../types/agent";

/** Receives the milestones of a run — see `AgentTraceEvent`. */
export type AgentTracer = (event: AgentTraceEvent) => void;

/**
 * Hand one event to a tracer.
 *
 * A tracer is an **observer**: a hook that throws is swallowed, so a broken
 * exporter can never fail the run it watches. The hook is synchronous — a
 * promise it returns is not awaited (and is not the framework's to settle).
 */
export function trace(tracer: AgentTracer | undefined, event: AgentTraceEvent): void {
    if (!tracer) return;
    try {
        tracer(event);
    } catch {
        // Observability must never be a failure mode of the run
    }
}
