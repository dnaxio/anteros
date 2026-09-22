/**
 * Import a tenant definition file (`*.model.ts`, `*.workflow.ts`, …) for a loader.
 *
 * A broken file (syntax error, throwing module) must never hide the other
 * definitions — nor the other tenants: the failure is logged and `null` is
 * returned, so the caller simply skips that file.
 */
async function importDefinition(file: string, kind: string): Promise<any | null> {
    try {
        return await import(file)
    } catch (err: any) {
        console.error(`Failed to load ${kind} '${file}':`, err?.message)
        return null
    }
}

export { importDefinition }
