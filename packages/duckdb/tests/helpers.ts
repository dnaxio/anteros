/**
 * Test helpers shared by the suites (a helper before a copy).
 */

/**
 * A port nothing is listening on, to hand to a Quack server — reserved by opening
 * and immediately closing a Bun server. The window between the two is tiny.
 */
export function freePort(): number {
    const probe = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = probe.port;
    probe.stop(true);
    if (port === undefined) throw new Error("could not reserve a port");
    return port;
}

/** Wait for the process to be up, without a fixed sleep. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
