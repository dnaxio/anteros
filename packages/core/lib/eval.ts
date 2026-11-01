import type { Agent } from "./agent";
import type {
    AgentCallOptions,
    AgentGenerateResult,
    AgentInput,
    AgentToolStats,
    AgentUsage,
} from "../types/agent";

/** One case of an evaluation — the input, and what this case overrides. */
export type AgentEvalCase = {
    /** Named in the report (default: `case-1`, `case-2`…). */
    name?: string;
    input: AgentInput;
    options?: AgentCallOptions;
};

/** What a grader may return: a bare score, or a score with its reason. */
export type AgentEvalGrader = (
    result: AgentGenerateResult,
    testCase: AgentEvalCase,
) => number | { score: number; reason?: string } | Promise<number | { score: number; reason?: string }>;

export type AgentEvalCaseReport = {
    name: string;
    /** Mean of this case's grader scores, in `0..1`. */
    score: number;
    /** The reasons the graders gave, in order (a thrown grader included). */
    reasons: string[];
    finishReason: string;
    usage: AgentUsage;
    toolStats: AgentToolStats;
};

export type AgentEvalReport = {
    /** Mean of the case scores, in `0..1` (`0` for no case). */
    score: number;
    /** Cases reaching `passScore`, or more. */
    passed: number;
    cases: AgentEvalCaseReport[];
};

/** A case passes at or above this score. */
const DEFAULT_PASS_SCORE = 0.5;

/** Keep whatever a grader returned inside `0..1`. */
function clampScore(score: number): number {
    if (!Number.isFinite(score)) return 0;
    return Math.min(1, Math.max(0, score));
}

function caseName(testCase: AgentEvalCase, index: number): string {
    return testCase.name?.trim() || `case-${index + 1}`;
}

/**
 * Run an agent over a list of cases and score the answers with graders.
 *
 * The cases run **sequentially** (a run may write to a thread), each one with
 * `options` overlaid by its own: `{ ...options, ...testCase.options }`.
 *
 * ```ts
 * const report = await evaluateAgent({
 *   agent,
 *   cases: [{ name: 'greeting', input: 'Say hello' }],
 *   graders: [(result) => (result.text.includes('hello') ? 1 : 0)],
 * });
 * ```
 */
export async function evaluateAgent(options: {
    agent: Agent;
    cases: AgentEvalCase[];
    graders: AgentEvalGrader[];
    /** A case passes at or above this score (default 0.5). */
    passScore?: number;
    /** Options merged into every case's call. */
    options?: AgentCallOptions;
}): Promise<AgentEvalReport> {
    const { agent, cases, graders } = options;
    const passScore = options.passScore ?? DEFAULT_PASS_SCORE;
    const reports: AgentEvalCaseReport[] = [];

    for (const [index, testCase] of cases.entries()) {
        const result = await agent.generate(testCase.input, { ...options.options, ...testCase.options });

        const scores: number[] = [];
        const reasons: string[] = [];
        for (const grader of graders) {
            try {
                const outcome = await grader(result, testCase);
                if (typeof outcome === "number") {
                    scores.push(clampScore(outcome));
                } else {
                    scores.push(clampScore(outcome.score));
                    if (outcome.reason) reasons.push(outcome.reason);
                }
            } catch (err: any) {
                // One broken grader is a zero, not the end of the evaluation
                scores.push(0);
                reasons.push(err?.message ?? String(err));
            }
        }

        reports.push({
            name: caseName(testCase, index),
            score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
            reasons,
            finishReason: result.finishReason,
            usage: result.usage,
            toolStats: result.toolStats,
        });
    }

    const score = reports.length
        ? reports.reduce((sum, report) => sum + report.score, 0) / reports.length
        : 0;

    return {
        score,
        passed: reports.filter((report) => report.score >= passScore).length,
        cases: reports,
    };
}
