// Resource parsing and conversion to Docker flags.
//
// Docker only supports hard limits (--cpus, --memory). There is no
// concept of "requests" in plain Docker, so we keep the format minimal:
// cpu + memory, mapped 1:1 to the corresponding Docker flags.

import type { Resources } from "./types.ts"

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CPU string and return its value in millicores.
 *   "500m"   -> 500
 *   "0.5"    -> 500
 *   "1"      -> 1000
 *   "2"      -> 2000
 *   "0.25"   -> 250
 */
export function parseCpuToMillicores(input: string): number {
  const s = input.trim()
  if (s.endsWith("m")) {
    const n = Number(s.slice(0, -1))
    if (Number.isNaN(n)) throw new Error("Invalid CPU value: " + input)
    return n
  }
  const n = Number(s)
  if (Number.isNaN(n)) throw new Error("Invalid CPU value: " + input)
  return n * 1000
}

/**
 * Parse a memory string and return its value in bytes.
 *   "512Mi" -> 512 * 1024 * 1024
 *   "1Gi"   -> 1024 * 1024 * 1024
 *   "256M"  -> 256 * 1000 * 1000 (decimal, like Docker)
 *   "1G"    -> 1 * 1000 * 1000 * 1000
 *   "1024"  -> 1024
 */
export function parseMemoryToBytes(input: string): number {
  const s = input.trim()
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTPE]i?)?B?$/i.exec(s)
  if (!m) throw new Error("Invalid memory value: " + input)
  const n = Number(m[1])
  const unit = (m[2] ?? "").toUpperCase()
  const binary = unit.endsWith("I")
  const k = binary ? 1024 : 1000
  const exp: Record<string, number> = {
    "": 0,
    K: 1,
    M: 2,
    G: 3,
    T: 4,
    P: 5,
    E: 6,
  }
  return Math.round(n * Math.pow(k, exp[unit.replace(/I$/, "")] ?? 0))
}

// ---------------------------------------------------------------------------
// Merging: pod.resources + container.resources
// ---------------------------------------------------------------------------

/**
 * Merge a pod-level resources with a container-level override.
 * Container fields win on conflict.
 */
export function mergeResources(
  pod: Resources | undefined,
  container: Resources | undefined,
): Resources {
  return {
    cpu: container?.cpu ?? pod?.cpu,
    memory: container?.memory ?? pod?.memory,
  }
}

// ---------------------------------------------------------------------------
// Docker flag generation
// ---------------------------------------------------------------------------

/** Convert millicores to Docker --cpus (decimal cores). */
export function millicoresToCpus(mc: number): string {
  return (mc / 1000).toString()
}

/** Convert bytes to Docker --memory string (decimal, like "512M"). */
export function bytesToDockerMemory(bytes: number): string {
  if (bytes < 1024) return bytes + "b"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + "k"
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + "M"
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + "G"
}

/**
 * Convert a Resources object to an array of `docker run` flags.
 * Returns an empty array if the object is empty / undefined.
 */
export function resourcesToDockerFlags(r: Resources | undefined): string[] {
  if (!r) return []
  const out: string[] = []

  if (r.cpu) {
    const mc = parseCpuToMillicores(r.cpu)
    out.push("--cpus=" + millicoresToCpus(mc))
  }
  if (r.memory) {
    const b = parseMemoryToBytes(r.memory)
    out.push("--memory=" + bytesToDockerMemory(b))
    // Unlimited swap so --memory is the only cap (Docker default is
    // 2x memory which is rarely what you want for limits).
    out.push("--memory-swap=-1")
  }
  return out
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Short summary used in the deploy plan (e.g. "1/1Gi" or "—"). */
export function describeResources(r: Resources | undefined): string {
  if (!r) return "—"
  const cpu = r.cpu ?? "—"
  const mem = r.memory ?? "—"
  if (cpu === "—" && mem === "—") return "—"
  return cpu + "/" + mem
}
