import { AppError, fn } from "../lib/error";
import * as func from "../utils/func";
import type { useRest } from "../database/rest";

/**
 * Shared HTTP plumbing between the collection/vars/service API (`server/api.ts`)
 * and the agents API (`server/agents.ts`).
 *
 * Extracted rather than duplicated: the access rule semantics (wildcard, boolean
 * vs function, token requirement) must stay identical everywhere — a divergence
 * here is a hole.
 */

function getAccessToken(c: any) {
    const t = c.get('token');
    return {
        value: (t?.value ?? null) as string | null,
        decoded: (t?.decoded ?? null) as Record<string, unknown> | null,
        provided: (t?.provided ?? false) as boolean,
        expired: (t?.expired ?? false) as boolean,
    };
}

function errorResponse(c: any, err: any) {
    const isAppError = err instanceof AppError;
    const status = isAppError ? Number(err.status) : 500;
    return c.json({
        message: isAppError ? err.message : 'Internal server error',
        code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
        meta: isAppError ? err.meta : undefined,
    }, status);
}

/**
 * Evaluate an `api.access` rule — **no rule = denied** (secure by default).
 *
 * - `true` → allowed without a token (public)
 * - `false` → denied
 * - function → **requires a valid, non-expired token**, then the rule decides
 *
 * `extra` is merged into the rule context (agents pass the agent, the action and
 * the input so a rule can decide on the payload it is about to run).
 */
async function evaluateAccess(
    access: { [key: string]: boolean | ((ctx: any) => boolean | Promise<boolean>) | undefined } | undefined,
    operation: string,
    rest: InstanceType<typeof useRest>,
    label: string,
    c: any,
    extra: Record<string, any> = {},
): Promise<void> {
    if (!access) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const hasWildcard = access['*'] !== undefined;
    const hasSpecific = access[operation] !== undefined;

    if (!hasWildcard && !hasSpecific) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const rule = hasSpecific ? access[operation] : access['*'];
    if (rule === undefined) return;

    // Boolean `true` → allow without requiring a token
    if (typeof rule === 'boolean') {
        if (!rule) {
            throw new AppError(`${label} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
        }
        return;
    }

    // Function → requires a valid token
    const accessToken = getAccessToken(c);

    if (accessToken.expired) {
        throw new AppError('Token expired', { status: 401, code: 'TOKEN_EXPIRED' });
    }
    if (!accessToken.value) {
        throw new AppError('Authentication required', { status: 401, code: 'AUTH_REQUIRED' });
    }

    const allowed = await (rule as Function)({
        rest,
        error: fn.error,
        jwt: func.jwt,
        token: accessToken,
        ...extra,
    });
    if (!allowed) {
        throw new AppError(`${label} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
    }
}

export { getAccessToken, errorResponse, evaluateAccess };
