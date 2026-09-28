/**
 * Agent **skills** — the documents an agent carries in its system prompt.
 *
 * The format is the one every skill file shares (`name`, `description`, `license`,
 * `compatibility`, `metadata`, `allowed-tools`), and the rules that matter are:
 * a missing `name`/`description` refuses the agent (a typo must never change the
 * prompt silently), a non-markdown file is skipped, and the same file matched by
 * two patterns is one skill.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { cfg, formatConfig } from "../server/config";
import { syncAgents, agents, createAgents } from "../lib/agents";
import { resolveSkills, skillsBlock, MAX_DESCRIPTION_CHARS } from "../lib/skills";
import { fakeProvider, anthropicText, request, type Fake } from "./fixtures/fake-provider";

const TENANT = "skills";
const FIXTURE = "packages/core/tests/fixtures/skills-tenant";

const resolve = (sources: any[]) => resolveSkills(sources, { baseDir: FIXTURE, agentId: "test" });
const names = (skills: any[]) => skills.map((skill) => skill.name);

describe("resolveSkills", () => {
    it("walks the tenant for a glob, a file, a regex and a `SKILL.md` — one skill per file", async () => {
        const skills = await resolve([
            "./docs/*.md",
            "./guide/ml.md",
            /^docs\/.*\.md$/, // the same file as the glob above: not injected twice
            /^runbooks\/.*$/, // catches a `.txt` too — skipped, see below
            "./guides/**/SKILL.md",
        ]);

        expect(names(skills)).toEqual(["incident-response", "ml-conventions", "pdf", "pdf-forms"]);
    });

    it("parses every field of the frontmatter, and strips it from the body", async () => {
        const [skill] = await resolve(["./docs/pdf-forms.md"]);

        expect(skill).toMatchObject({
            name: "pdf-forms",
            license: "MIT",
            compatibility: "Needs the `pdftk` binary on the host.",
            metadata: { owner: "platform", reviewed: "2026-09-24" },
            allowedTools: ["read_pdf", "write_pdf"],
            source: "docs/pdf-forms.md",
        });
        expect(skill!.content.startsWith("# Filling a form")).toBe(true);
        expect(skill!.content).toContain("dump_data_fields");
        expect(skill!.content).not.toContain("pdftk` binary");
    });

    it("skips a file that is not markdown instead of refusing the agent", async () => {
        const skills = await resolve([/^runbooks\/.*$/]);

        // `runbooks/notes.txt` matched the regex and was left out (logged)
        expect(names(skills)).toEqual(["incident-response"]);
    });

    it("keeps an unknown frontmatter key out of the skill", async () => {
        const [skill] = await resolve(["./broken/unknown-key.md"]);

        expect(skill!.name).toBe("unknown-keys");
        expect((skill as any).version).toBeUndefined();
        expect((skill as any).author).toBeUndefined();
    });

    it("refuses what the format requires, naming the file", async () => {
        await expect(resolve(["./broken/plain.md"])).rejects.toThrow(/`name` is required/);
        await expect(resolve(["./broken/no-name.md"])).rejects.toMatchObject({ code: "AGENT_SKILL_INVALID" });
        await expect(resolve(["./broken/no-description.md"])).rejects.toThrow(/`description` is required/);
        await expect(resolve(["./broken/bad-name.md"])).rejects.toThrow(/lowercase alphanumeric with hyphens/);
        await expect(resolve(["./broken/mismatch/SKILL.md"])).rejects.toThrow(/must match the parent directory/);
        // A skill *is* its body: frontmatter alone injects nothing
        await expect(resolve(["./broken/empty-body.md"])).rejects.toThrow(/`content` is required/);
    });

    it("refuses a field over its limit", async () => {
        await expect(resolve(["./broken/long-description.md"])).rejects.toThrow(new RegExp(`over the ${MAX_DESCRIPTION_CHARS} limit`));
        await expect(resolve(["./broken/long-compat.md"])).rejects.toThrow(/`compatibility` is 510 characters/);
    });

    it("refuses two skills that share a name", async () => {
        await expect(resolve(["./broken/dup-a.md", "./broken/dup-b.md"]))
            .rejects.toMatchObject({ code: "AGENT_SKILL_DUPLICATE" });
    });

    it("takes no source as no skills", async () => {
        expect(await resolve([])).toEqual([]);
    });
});

describe("skillsBlock", () => {
    it("renders one section per skill, description first", async () => {
        const block = skillsBlock(await resolve(["./guide/ml.md"]));

        expect(block.startsWith("## Skills")).toBe(true);
        expect(block).toContain("### ml-conventions");
        expect(block).toContain("feature naming, training splits");
        expect(block).toContain("Features are `snake_case`");
        // the frontmatter never reaches the prompt
        expect(block).not.toContain("description:");
    });

    it("is empty without a skill", () => {
        expect(skillsBlock([])).toBe("");
    });
});

describe("agent skills", () => {
    let provider: Fake;

    beforeAll(async () => {
        formatConfig({
            server: { port: 4000 },
            tenants: [{ id: TENANT, dir: FIXTURE, database: { uri: "mongodb://localhost:27017/none" } }],
        });
        await syncAgents();
    });

    afterAll(() => {
        cfg.agents = [];
        try { provider?.stop(); } catch (_) {}
    });

    it("resolves the declared skills once, at load", () => {
        const agent = agents.get(TENANT, "docs");

        expect(names(agent!.getSkills())).toEqual(["incident-response", "ml-conventions", "pdf", "pdf-forms"]);

        // The copy bound to a calling `rest` shares the declaration, skills included
        const bound = createAgents(TENANT, { tenant_id: TENANT } as any).get("docs");
        expect(names(bound!.getSkills())).toEqual(names(agent!.getSkills()));
    });

    it("refuses the agent whose skill is malformed, and keeps the others", () => {
        expect(agents.has(TENANT, "incomplete")).toBe(false);
        expect(agents.has(TENANT, "docs")).toBe(true);
        expect(agents.ids(TENANT)).toEqual(["docs"]);
    });

    it("injects them into the system prompt of a run", async () => {
        provider = fakeProvider(() => anthropicText("ok"));
        const agent = agents.get(TENANT, "docs")!;
        agent.setProvider({ baseUrl: provider.url });

        await agent.generate("How do I fill a form?");

        const system: string = request(provider, 0).body.system;
        expect(system.startsWith("Answer from the documentation you were given.")).toBe(true);
        expect(system).toContain("## Skills");
        expect(system).toContain("### pdf-forms");
        expect(system).toContain("Fill, flatten and merge PDF forms.");
        expect(system).toContain("dump_data_fields");
        expect(system).toContain("### incident-response");
    });

    it("keeps the skills when the caller overrides the instructions", async () => {
        const agent = agents.get(TENANT, "docs")!;
        agent.setProvider({ baseUrl: provider.url });

        await agent.generate("hi", { instructions: "You are a pirate." });

        const system: string = request(provider, 1).body.system;
        expect(system.startsWith("You are a pirate.")).toBe(true);
        expect(system).toContain("### pdf");
    });

    it("serves name and description on info — never the body", () => {
        const info = agents.get(TENANT, "docs")!.toJSON();

        expect(info.skills).toHaveLength(4);
        expect(info.skills[0]).toEqual({
            name: "incident-response",
            description: "What to do when production breaks — paging, comms, post-mortem.",
        });
        expect(JSON.stringify(info)).not.toContain("Acknowledge the page");
    });
});
