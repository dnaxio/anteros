import { Glob } from "bun";
import path from "node:path";
import fs from "node:fs/promises";
import { AppError } from "./error";
import { logger } from "../utils/logger";
import type { AgentSkill, AgentSkillSource } from "../types/agent";

/**
 * Agent **skills** — markdown documents declared on an agent
 * (`skills: ['./docs/*.md', './guide/ml.md', /^runbooks\/.*\.md$/]`), resolved
 * once at load and injected into the **system prompt** of every run.
 *
 * A skill file is markdown with a frontmatter header:
 *
 * ```md
 * ---
 * name: pdf-forms
 * description: Fill, flatten and merge PDF forms. Use for any AcroForm work.
 * license: MIT
 * compatibility: Needs the `pdftk` binary.
 * metadata: { owner: platform }
 * allowed-tools: read_pdf write_pdf
 * ---
 *
 * # Filling a form
 * …
 * ```
 *
 * `name` and `description` are required; the body is what the model reads.
 */

/** Kebab-case, and short — the name identifies a skill in the prompt. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const MAX_COMPATIBILITY_CHARS = 500;
/**
 * Per-file ceiling. A skill is a prompt document, read on **every** call: past
 * this, the agent is better served by a tool than by a document (same order of
 * magnitude as the attachment text limit).
 */
const MAX_SKILL_CHARS = 200_000;

/** The keys the format defines — anything else is kept out of the prompt. */
const KNOWN_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools", "allowedTools"]);

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

type Line = { indent: number; text: string };

/** Drop a trailing ` # comment`, unless the `#` sits inside a quoted value. */
function stripComment(line: string): string {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const char = line[i]!;
        if (quote) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
            return line.slice(0, i).replace(/\s+$/, "");
        }
    }
    return line;
}

/** Index of the `:` that separates a key from its value (outside quotes). */
function keySeparator(text: string): number {
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        if (quote) {
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === ":" && (i === text.length - 1 || /\s/.test(text[i + 1]!))) return i;
    }
    return -1;
}

function unquote(text: string): string {
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
        const body = text.slice(1, -1);
        return text[0] === '"' ? body.replace(/\\"/g, '"') : body.replace(/''/g, "'");
    }
    return text;
}

function scalar(text: string): any {
    const raw = text.trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
        const inner = raw.slice(1, -1).trim();
        return inner ? splitTopLevel(inner, ",").map((item) => scalar(item)).filter((item) => item !== undefined) : [];
    }
    if (raw.startsWith("{") && raw.endsWith("}")) {
        const inner = raw.slice(1, -1).trim();
        if (!inner) return {};
        const out: Record<string, any> = {};
        for (const pair of splitTopLevel(inner, ",")) {
            const separator = keySeparator(pair.trim());
            if (separator === -1) continue;
            out[unquote(pair.slice(0, separator).trim())] = scalar(pair.slice(separator + 1).trim());
        }
        return out;
    }
    if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) return unquote(raw);
    if (raw === "" || raw === "null" || raw === "~") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
    return raw;
}

/** Split on a separator that is outside quotes and outside `[…]` / `{…}`. */
function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = "";

    for (const char of text) {
        if (quote) {
            current += char;
            if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === "[" || char === "{") depth += 1;
        if (char === "]" || char === "}") depth -= 1;
        if (char === separator && depth === 0) {
            parts.push(current.trim());
            current = "";
            continue;
        }
        current += char;
    }
    parts.push(current.trim());
    return parts;
}

/**
 * The block reader behind `parseYaml()` — mappings and sequences, nested by
 * indentation, `[a, b]` inline.
 */
function parseBlock(lines: Line[], start: number, indent: number): [any, number] {
    const first = lines[start];
    if (!first) return [{}, start];

    // Sequence: `- value`, or `-` followed by a deeper block
    if (first.text === "-" || first.text.startsWith("- ")) {
        const out: any[] = [];
        let index = start;
        while (index < lines.length) {
            const line = lines[index]!;
            if (line.indent !== first.indent || !(line.text === "-" || line.text.startsWith("- "))) break;
            const inline = line.text.slice(1).trim();
            index += 1;
            if (inline) {
                out.push(scalar(inline));
                continue;
            }
            const next = lines[index];
            if (next && next.indent > first.indent) {
                const [nested, after] = parseBlock(lines, index, next.indent);
                out.push(nested);
                index = after;
            } else {
                out.push(null);
            }
        }
        return [out, index];
    }

    // Mapping
    const out: Record<string, any> = {};
    let index = start;
    while (index < lines.length) {
        const line = lines[index]!;
        if (line.indent < indent) break;
        if (line.indent > indent) {
            index += 1; // a stray deeper line: ignore rather than guess
            continue;
        }
        const separator = keySeparator(line.text);
        if (separator === -1) {
            index += 1;
            continue;
        }
        const key = unquote(line.text.slice(0, separator).trim());
        const rest = line.text.slice(separator + 1).trim();
        index += 1;
        if (rest) {
            out[key] = scalar(rest);
            continue;
        }
        const next = lines[index];
        if (next && next.indent > indent) {
            const [nested, after] = parseBlock(lines, index, next.indent);
            out[key] = nested;
            index = after;
        } else {
            out[key] = null;
        }
    }
    return [out, index];
}

/**
 * A dependency-free reader for the frontmatter of a skill file — a **documented
 * subset of YAML**, the same way `lib/zip.ts` reads an archive without a library.
 *
 * Handled: `key: value` (quoted or not, `true`/`false`/`null`/numbers), blocks
 * nested by indentation, sequences (`- item`), and the inline forms — `[a, b]`,
 * `{ key: value }`.
 * Not handled, on purpose: multi-line scalars (`|`, `>`), anchors, tags, multiple
 * documents. A skill file does not need them.
 */
function parseYaml(block: string): Record<string, any> {
    const lines: Line[] = [];
    for (const raw of block.split("\n")) {
        if (!raw.trim()) continue;
        const stripped = stripComment(raw);
        if (!stripped.trim()) continue;
        lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
    }
    const [value] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Split a skill file into its frontmatter and its body. No frontmatter at all is
 * not an error here — validation says so, with a message that names the file.
 */
function parseFrontmatter(text: string): { data: Record<string, any>; content: string } {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!/^---\s*\n/.test(normalized)) return { data: {}, content: normalized.trim() };

    const end = normalized.indexOf("\n---", 3);
    if (end === -1) return { data: {}, content: normalized.trim() };

    const data = parseYaml(normalized.slice(normalized.indexOf("\n") + 1, end + 1));
    const content = normalized.slice(end + 4).replace(/^\s*\n/, "").trim();
    return { data, content };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

function invalid(skill: string, message: string): AppError {
    return new AppError(`Skill '${skill}': ${message}`, { status: 500, code: "AGENT_SKILL_INVALID" });
}

/** The body a skill must carry — it *is* the skill. */
function requireContent(content: any, label: string): string {
    const body = typeof content === "string" ? content.trim() : "";
    if (!body) throw invalid(label, "`content` is required — a skill is the text the model reads");
    return body;
}

function asString(value: any): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    return typeof value === "string" ? value : String(value);
}

/**
 * The files a source selects, as absolute paths. A **string** is a path or a glob
 * (``.` = the tenant directory); a **RegExp** is matched against every file of the
 * tenant directory, on the relative POSIX path (`runbooks/incident.md`).
 *
 * The glob is split in two — the directory chain that holds no wildcard, then the
 * pattern — so `Bun.Glob` always scans from a real root instead of depending on the
 * process cwd (a relative tenant dir would otherwise be prefixed twice).
 */
async function matchFiles(source: AgentSkillSource, baseDir: string): Promise<string[]> {
    if (source instanceof RegExp) {
        // `g`/`y` carry a `lastIndex` between calls — one regex must not skip files
        const pattern = new RegExp(source.source, source.flags.replace(/[gy]/g, ""));
        const found: string[] = [];
        for await (const file of new Glob("**/*").scan(baseDir)) {
            const relative = file.split(path.sep).join("/");
            if (pattern.test(relative)) found.push(path.join(baseDir, file));
        }
        return found;
    }

    const pattern = String(source ?? "").trim();
    if (!pattern) return [];

    const target = path.resolve(baseDir, pattern);
    const parts = target.split(path.sep);
    let wildcard = parts.findIndex((part) => /[*?[\]{}]/.test(part));
    if (wildcard === -1) wildcard = parts.length - 1; // a plain file: scan its directory

    const root = parts.slice(0, wildcard).join(path.sep) || path.sep;
    const rest = parts.slice(wildcard).join("/");

    const found: string[] = [];
    for await (const file of new Glob(rest).scan(root)) {
        found.push(path.resolve(root, file));
    }
    return found;
}

/**
 * Validate the header of a skill file. `label` names the source in the messages
 * (the path relative to the tenant directory).
 */
function validateSkill(data: Record<string, any>, label: string): Omit<AgentSkill, "content" | "source"> {
    const name = asString(data.name);
    if (!name) throw invalid(label, "`name` is required");
    if (name.length > MAX_NAME_CHARS || !SKILL_NAME.test(name)) {
        throw invalid(label, `\`name\` must be lowercase alphanumeric with hyphens, 1-${MAX_NAME_CHARS} characters (got '${name}')`);
    }
    // The directory-skill layout (`pdf/SKILL.md`): the name is the directory's, so a
    // folder copied or renamed cannot serve a skill under a stale identity
    if (label && path.basename(label).toLowerCase() === "skill.md") {
        const parent = path.basename(path.dirname(label));
        if (parent !== name) throw invalid(label, `\`name\` must match the parent directory ('${parent}') for a SKILL.md`);
    }

    const description = asString(data.description);
    if (!description) throw invalid(label, "`description` is required");
    if (description.length > MAX_DESCRIPTION_CHARS) {
        throw invalid(label, `\`description\` is ${description.length} characters — over the ${MAX_DESCRIPTION_CHARS} limit`);
    }

    const compatibility = asString(data.compatibility);
    if (compatibility && compatibility.length > MAX_COMPATIBILITY_CHARS) {
        throw invalid(label, `\`compatibility\` is ${compatibility.length} characters — over the ${MAX_COMPATIBILITY_CHARS} limit`);
    }

    const metadata = data.metadata ?? undefined;
    if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) {
        throw invalid(label, "`metadata` must be a mapping of key-value pairs");
    }

    const allowed = data["allowed-tools"] ?? data.allowedTools;
    let allowedTools: string[] | undefined;
    if (Array.isArray(allowed)) allowedTools = allowed.map((item) => String(item));
    else if (typeof allowed === "string") allowedTools = allowed.split(/\s+/).filter(Boolean);
    else if (allowed !== undefined && allowed !== null) throw invalid(label, "`allowed-tools` must be a space-separated list");

    return {
        name,
        description,
        license: asString(data.license),
        compatibility,
        metadata: metadata as Record<string, any> | undefined,
        allowedTools,
    };
}

/** Read one file and validate its frontmatter against the skill format. */
async function readSkill(file: string, relative: string): Promise<AgentSkill> {
    const raw = await fs.readFile(file, "utf8");
    if (raw.length > MAX_SKILL_CHARS) {
        throw new AppError(
            `Skill '${relative}' is ${raw.length} characters — over the ${MAX_SKILL_CHARS} limit (a skill is injected in every prompt)`,
            { status: 500, code: "AGENT_SKILL_TOO_LARGE" },
        );
    }

    const { data, content } = parseFrontmatter(raw);

    for (const key of Object.keys(data)) {
        if (!KNOWN_KEYS.has(key)) {
            logger.file("warn", "agent skill: unknown frontmatter key ignored", { skill: relative, key });
        }
    }

    return { ...validateSkill(data, relative), content: requireContent(content, relative), source: relative };
}

/**
 * Resolve the `skills` of an agent into the documents injected into its system
 * prompt, in a stable order (by name).
 *
 * A source is a **string** — a path or a glob — or a **RegExp**, a walk of the
 * tenant: a skill is a **link to markdown files**, never a declaration. A file that
 * is **not markdown** is skipped with a line in the log rather than refused: a
 * pattern meant to catch a folder must not take an agent down because a `README.txt`
 * lives beside the skills. Everything else — a missing `name`, a name that is not
 * kebab-case, a description over the limit, an empty body, two skills sharing a name
 * — refuses the agent at load, so a typo never changes the prompt silently (the
 * loader logs it and keeps the other agents).
 */
async function resolveSkills(
    sources: AgentSkillSource[] | undefined,
    options: { baseDir: string; agentId?: string },
): Promise<AgentSkill[]> {
    if (!sources?.length) return [];

    const byFile = new Map<string, AgentSkill>();

    for (const source of sources) {
        const files = await matchFiles(source, options.baseDir);
        // A pattern that selects nothing is a typo, not a choice — say so
        if (!files.length) {
            logger.file("warn", "agent skill: pattern matched no file", {
                agent: options.agentId,
                pattern: source instanceof RegExp ? source.source : source,
            });
        }
        for (const file of files) {
            const relative = path.relative(options.baseDir, file).split(path.sep).join("/");
            if (byFile.has(relative)) continue;

            if (!relative.toLowerCase().endsWith(".md")) {
                logger.file("warn", "agent skill skipped: not markdown", {
                    agent: options.agentId,
                    skill: relative,
                });
                continue;
            }

            byFile.set(relative, await readSkill(file, relative));
        }
    }

    const skills = [...byFile.values()].sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Map<string, string>();
    for (const skill of skills) {
        const previous = seen.get(skill.name);
        if (previous) {
            throw new AppError(
                `Skill '${skill.source}': the name '${skill.name}' is already used by '${previous}' — two skills of an agent must not share one`,
                { status: 500, code: "AGENT_SKILL_DUPLICATE" },
            );
        }
        seen.set(skill.name, skill.source);
    }

    return skills;
}

/**
 * The system-prompt block of the skills. Static by nature — no store, nothing
 * resolved per run — which is why it is injected **before** the working memory:
 * the prefix of the prompt stays cacheable.
 */
function skillsBlock(skills: AgentSkill[]): string {
    if (!skills.length) return "";

    const parts = [
        "## Skills",
        "",
        "Reference documents you can rely on. Read the ones that match the task at hand instead of guessing, and apply them as written.",
    ];

    for (const skill of skills) {
        parts.push("", `### ${skill.name}`, "", skill.description);
        if (skill.content) parts.push("", skill.content);
    }

    return parts.join("\n");
}

export {
    MAX_SKILL_CHARS,
    MAX_DESCRIPTION_CHARS,
    MAX_COMPATIBILITY_CHARS,
    MAX_NAME_CHARS,
    parseFrontmatter,
    resolveSkills,
    skillsBlock,
};
