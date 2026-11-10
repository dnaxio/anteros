import { chmod, readFile, writeFile } from "node:fs/promises";

/** `JWT_SECRET=…` with optional indentation and spaces around `=`. */
const ASSIGNMENT = /^(\s*)JWT_SECRET\s*=\s*(.*)$/;

/**
 * Persist an auto-generated `JWT_SECRET` in an env file, **owner-only** (`0600`).
 *
 * The secret is a signing key: a world-readable `.env` (the default umask, often
 * `0644`) hands every local user the ability to mint tokens. The mode is applied on
 * creation (`writeFile`) **and** enforced after (`chmod`), because `writeFile`
 * keeps an existing file's mode.
 *
 * The file is read **line by line**: a comment that mentions `JWT_SECRET=` is not an
 * assignment (it used to block persistence, leaving the generated secret in memory —
 * every restart then invalidated every token, #63), and an **empty** assignment is
 * filled in place instead of being duplicated. Only a non-empty value is left alone.
 *
 * Returns `true` when the file was written, `false` when it already held a secret.
 */
async function saveJwtSecret(secret: string, envPath = ".env"): Promise<boolean> {
    if (!secret) throw new Error("saveJwtSecret: secret is required");

    let content = "";
    try {
        content = await readFile(envPath, "utf8");
    } catch {
        // missing file — created below
    }

    const lines = content ? content.split("\n") : [];
    // A final newline leaves an empty last line — drop it before appending
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

    let emptyAt = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue; // blank or comment
        const match = ASSIGNMENT.exec(line);
        if (!match) continue;
        if (match[2]!.trim()) return false; // a real secret already wins
        if (emptyAt === -1) emptyAt = i; // remember the empty slot
    }

    if (emptyAt >= 0) {
        const indent = ASSIGNMENT.exec(lines[emptyAt]!)![1];
        lines[emptyAt] = `${indent}JWT_SECRET=${secret}`;
    } else {
        lines.push("# Auto-generated on boot", `JWT_SECRET=${secret}`);
    }

    await writeFile(envPath, lines.join("\n") + "\n", { mode: 0o600 });
    await chmod(envPath, 0o600);
    return true;
}

export { saveJwtSecret };
