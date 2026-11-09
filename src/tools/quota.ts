import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { describeError } from "../errors.js";
import { toolText } from "./util.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

type DiagnosisQuotaTier = "T0" | "T1" | "T2" | "T3" | "T4";

const FIXED_DIAGNOSIS_LIMITS = { T0: 3, T1: 10, T2: 50 } as const;

function diagnosisQuotaTier(value: unknown): DiagnosisQuotaTier | undefined {
  return value === "T0" || value === "T1" || value === "T2" || value === "T3" || value === "T4"
    ? value
    : undefined;
}

function safeCounterInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeQuotaAction(
  tier: DiagnosisQuotaTier,
  value: unknown,
): { label: string; href: "/signup" | "/pricing" } | undefined {
  const action = record(value);
  if (
    !action
    || typeof action.label !== "string"
    || !action.label.trim()
    || action.label.trim().length > 240
    || /[\u0000-\u001F\u007F]/.test(action.label)
  ) return undefined;
  const { code, href } = action;
  const matches = tier === "T0"
    ? (code === "CREATE_ACCOUNT" && href === "/signup")
      || (code === "VERIFY_OR_START_TRIAL" && href === "/pricing")
    : tier === "T1"
      ? code === "VERIFY_OR_START_TRIAL" && href === "/pricing"
      : tier === "T2"
        ? code === "START_TRIAL_OR_UPGRADE" && href === "/pricing"
        : tier === "T3"
          ? code === "UPGRADE_PLAN" && href === "/pricing"
          : false;
  return matches
    ? { label: action.label.trim(), href: href as "/signup" | "/pricing" }
    : undefined;
}

/** Format the API quota object without inferring an allowance from the billing plan. */
export function formatQuotaResponse(q: Record<string, unknown>): string {
  const plan = typeof q.plan === "string" ? q.plan : "free";
  const quota = record(q.quota) ?? {};
  const rawTier = quota.tier ?? q.tier;
  const tier = diagnosisQuotaTier(rawTier);
  const hasLimit = Object.prototype.hasOwnProperty.call(quota, "limit")
    || Object.prototype.hasOwnProperty.call(quota, "dailyLimit");
  const rawLimit = Object.prototype.hasOwnProperty.call(quota, "limit")
    ? quota.limit
    : quota.dailyLimit;
  const rawRemaining = Object.prototype.hasOwnProperty.call(quota, "remaining")
    ? quota.remaining
    : q.remaining;
  let unlimited = false;
  let limit: number | undefined;
  let remaining: number | undefined;
  let invalidModernCounter = rawTier !== undefined && tier === undefined;

  if (tier) {
    const finiteLimit = safeCounterInteger(rawLimit);
    const expectedFixed = tier === "T0" || tier === "T1" || tier === "T2"
      ? FIXED_DIAGNOSIS_LIMITS[tier]
      : undefined;
    const limitIsValid = tier === "T4"
      ? rawLimit === null
      : tier === "T3"
        ? rawLimit === null || (finiteLimit !== undefined && finiteLimit > 0)
        : finiteLimit === expectedFixed;
    const finiteRemaining = safeCounterInteger(rawRemaining);
    const remainingIsValid = rawLimit === null
      ? rawRemaining === null
      : rawRemaining === null
        ? quota.meteringAvailable === false
        : finiteRemaining !== undefined && finiteLimit !== undefined && finiteRemaining <= finiteLimit;
    invalidModernCounter = !limitIsValid || !remainingIsValid;
    if (!invalidModernCounter) {
      unlimited = rawLimit === null;
      limit = finiteLimit;
      remaining = finiteRemaining;
    }
  } else if (rawTier === undefined) {
    // Backward compatibility for the older response, without inferring a limit
    // from a billing plan string.
    unlimited = hasLimit && (rawLimit === null || rawLimit === "unlimited");
    limit = finiteNumber(rawLimit);
    remaining = finiteNumber(rawRemaining);
  }

  const rawReset = typeof quota.resetsAt === "string"
    ? quota.resetsAt
    : typeof quota.resetAt === "string"
      ? quota.resetAt
      : typeof q.resetsAt === "string"
        ? q.resetsAt
        : undefined;
  const reset = rawReset && Number.isFinite(Date.parse(rawReset)) ? rawReset : undefined;
  const nextAction = tier ? safeQuotaAction(tier, quota.nextAction ?? q.nextAction) : undefined;
  const gpuLimit = q.gpuLimit;

  const lines = [`**Plan:** ${plan}`];
  if (tier) lines.push(`**Allowance tier:** ${tier}`);
  if (unlimited) {
    lines.push("**Diagnoses:** unlimited");
  } else if (invalidModernCounter) {
    lines.push("**Diagnoses:** allowance data unavailable");
  } else if (limit !== undefined) {
    lines.push(`**Diagnoses remaining today:** ${remaining ?? "temporarily unavailable"} of ${limit}`);
  } else if (remaining !== undefined) {
    // Backward compatibility with the older API shape, which exposed remaining but
    // omitted the limit. Do not invent a denominator from the billing plan.
    lines.push(`**Diagnoses remaining today:** ${remaining}`);
  }
  if (reset && !unlimited) lines.push(`**Resets at:** ${reset}`);
  if (gpuLimit !== undefined) {
    lines.push(`**Largest job:** ${gpuLimit === "unlimited" ? "unlimited GPUs" : `up to ${gpuLimit} GPUs`}`);
  }
  if (nextAction) {
    lines.push("", `**Next action:** ${nextAction.label} https://denpex.com${nextAction.href}`);
  }
  return lines.join("\n");
}

// Show the engineer's plan and remaining diagnosis quota.
export function registerQuota(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "check_quota",
    {
      title: "Check Denpex plan & quota",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: "Show your Denpex plan, allowance tier, and diagnoses left today.",
      inputSchema: {},
    },
    async () => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const q = await ctx.client.request<Record<string, unknown>>("/api/diagnose/quota");
        return toolText(formatQuotaResponse(q));
      } catch (e) {
        return toolText(`Could not fetch quota: ${describeError(e)}`, true);
      }
    },
  );
}
