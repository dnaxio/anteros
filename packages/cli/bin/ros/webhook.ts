// Webhook notifier for deploy / rollback events.
//
// `ros` POSTs a JSON event to the configured URL after every deploy
// or rollback. The payload is generic and works with any HTTP receiver
// (Slack, Discord, n8n, custom audit server, etc.).
//
// Payload schema:
//   {
//     event:        "deploy.completed" | "deploy.failed" | "rollback.completed" | "rollback.failed"
//     pod:          string                 // pod name
//     env:          string                 // environment name
//     tag:          string                 // image tag deployed
//     deployer:     string                 // user / CI run
//     timestamp:    string                 // ISO 8601
//     servers:      string[]               // list of target SSH targets
//     duration_sec: number                 // how long the operation took
//     result:       "success" | "failure"
//     error?:       string                 // error message (only on failure)
//   }
//
// The webhook can be configured as a simple URL string or as an object
// with custom headers and an optional HMAC secret:
//
//   webhook: https://hooks.slack.com/...        # simple
//
//   webhook:                                     # full
//     url: https://api.example.com/events
//     headers:
//       Authorization: "Bearer xxx"
//       X-Tenant: prod
//     secret: ${WEBHOOK_SECRET}
//
// If `secret` is set, the payload is signed with HMAC-SHA256 and the
// signature is sent in `X-Ros-Signature`.

import { createHmac } from "node:crypto"

export interface WebhookEvent {
  event: string
  pod: string
  env: string
  tag: string
  deployer: string
  timestamp: string
  servers: string[]
  duration_sec: number
  result: "success" | "failure"
  error?: string
}

/** Normalized webhook config (always has url, headers, secret). */
export interface WebhookConfig {
  url: string
  headers: Record<string, string>
  secret?: string
  /** Optional list of event names to forward. */
  events?: string[]
}

/**
 * Normalize a webhook target from the YAML config.
 * Accepts either a URL string or a full `WebhookTarget` object.
 * `events` is optional and only used by callers that support it.
 */
export function normalizeWebhook(
  raw: string | { url: string; headers?: Record<string, string>; secret?: string } | undefined,
  events?: string[],
): WebhookConfig | undefined {
  if (!raw) return undefined
  if (typeof raw === "string") {
    return { url: raw, headers: {}, events }
  }
  return {
    url: raw.url,
    headers: raw.headers ?? {},
    secret: raw.secret,
    events,
  }
}

/** Result of a webhook delivery. */
export interface WebhookResult {
  ok: boolean
  status: number
  body?: string
  error?: string
  skipped?: boolean
  reason?: string
}

/** Decide if an event should be sent based on the `events` filter. */
export function shouldSend(event: string, events: string[] | undefined): boolean {
  if (!events || events.length === 0) return true
  for (const pat of events) {
    if (pat === event) return true
    if (pat.endsWith(".*")) {
      const prefix = pat.slice(0, -1)
      if (event.startsWith(prefix)) return true
    }
    if (pat === "*") return true
  }
  return false
}

/** Compute the HMAC-SHA256 signature of a payload, hex-encoded. */
export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex")
}

/**
 * Send a webhook event. Never throws — failures are returned as
 * `{ ok: false, error }` so the caller can warn but not fail the deploy.
 */
export async function sendWebhook(
  cfg: WebhookConfig | undefined,
  event: WebhookEvent,
): Promise<WebhookResult> {
  if (!cfg || !cfg.url) {
    return { ok: true, status: 0, skipped: true, reason: "no webhook configured" }
  }
  if (!shouldSend(event.event, cfg.events)) {
    return { ok: true, status: 0, skipped: true, reason: "event filtered out" }
  }

  const body = JSON.stringify(event)
  // Merge: custom headers first, then our defaults (defaults can be
  // overridden by user headers like Content-Type if really needed),
  // then the HMAC signature last so it always wins.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "ros/0.0.1",
    ...cfg.headers,
  }
  if (cfg.secret) {
    headers["X-Ros-Signature"] = "sha256=" + signPayload(body, cfg.secret)
  }

  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body,
      // 5s timeout so a slow webhook doesn't block the deploy
      signal: AbortSignal.timeout(5000),
    })
    const text = await res.text().catch(() => "")
    return { ok: res.ok, status: res.status, body: text.slice(0, 200) }
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message }
  }
}

/** Build a webhook event for a successful deploy. */
export function makeDeployEvent(
  pod: string,
  env: string,
  tag: string,
  servers: string[],
  durationSec: number,
  deployer = process.env.USER ?? process.env.USERNAME ?? "unknown",
): WebhookEvent {
  return {
    event: "deploy.completed",
    pod,
    env,
    tag,
    deployer,
    timestamp: new Date().toISOString(),
    servers,
    duration_sec: durationSec,
    result: "success",
  }
}

export function makeDeployFailedEvent(
  pod: string,
  env: string,
  tag: string,
  servers: string[],
  durationSec: number,
  errorMsg: string,
  deployer = process.env.USER ?? process.env.USERNAME ?? "unknown",
): WebhookEvent {
  return {
    event: "deploy.failed",
    pod,
    env,
    tag,
    deployer,
    timestamp: new Date().toISOString(),
    servers,
    duration_sec: durationSec,
    result: "failure",
    error: errorMsg,
  }
}

export function makeRollbackEvent(
  pod: string,
  env: string,
  fromTag: string,
  toTag: string,
  servers: string[],
  durationSec: number,
  deployer = process.env.USER ?? process.env.USERNAME ?? "unknown",
): WebhookEvent {
  return {
    event: "rollback.completed",
    pod,
    env,
    tag: toTag,
    deployer,
    timestamp: new Date().toISOString(),
    servers,
    duration_sec: durationSec,
    result: "success",
  }
}
