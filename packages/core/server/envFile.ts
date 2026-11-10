import { chmod, readFile, writeFile } from "node:fs/promises";

/**
 * Persist an auto-generated `JWT_SECRET` in an env file, **owner-only** (`0600`).
 *
 * The secret is a signing key: a world-readable `.env` (the default umask, often
 * `0644`) hands every local user the ability to mint tokens. The mode is applied on
 * creation (`writeFile`) **and** enforced after (`chmod`), because `writeFile`
 * keeps an existing file's mode.
 *
 * Returns `true` when the line was appended, `false` when the file already declared
 * a `JWT_SECRET` (nothing is touched, not even the mode).
 */
async function saveJwtSecret(secret: string, envPath = ".env"): Promise<boolean> {
    if (!secret) throw new Error("saveJwtSecret: secret is required");

    let content = "";
    try {
        content = await readFile(envPath, "utf8");
    } catch {
        // missing file — created below
    }
    if (content.includes("JWT_SECRET=")) return false;

    const suffix = content && !content.endsWith("\n") ? "\n" : "";
    await writeFile(envPath, `${content}${suffix}# Auto-generated on boot\nJWT_SECRET=${secret}\n`, { mode: 0o600 });
    await chmod(envPath, 0o600);
    return true;
}

export { saveJwtSecret };
