// Turn Denpex API failures into short, actionable messages the model (and the
// engineer reading the tool output) can act on, never a raw status or stack.

export class DenpexError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "DenpexError";
  }
}

function field(body: unknown, key: string): string | undefined {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  }
  return undefined;
}

type ExhaustibleDiagnosisTier = "T0" | "T1" | "T2" | "T3";
type DiagnosisActionCode =
  | "CREATE_ACCOUNT"
  | "VERIFY_OR_START_TRIAL"
  | "START_TRIAL_OR_UPGRADE"
  | "UPGRADE_PLAN";

interface DiagnosisAllowanceError {
  tier: ExhaustibleDiagnosisTier;
  limit: number;
  remaining: 0;
  resetsAt: string;
  nextAction: {
    code: DiagnosisActionCode;
    label: string;
    href: "/signup" | "/pricing";
  };
}

const FIXED_DIAGNOSIS_LIMITS = {
  T0: 3,
  T1: 10,
  T2: 50,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionMatchesTier(
  tier: ExhaustibleDiagnosisTier,
  code: unknown,
  href: "/signup" | "/pricing",
): code is DiagnosisActionCode {
  if (tier === "T0") {
    return (code === "CREATE_ACCOUNT" && href === "/signup")
      || (code === "VERIFY_OR_START_TRIAL" && href === "/pricing");
  }
  if (tier === "T1") return code === "VERIFY_OR_START_TRIAL" && href === "/pricing";
  if (tier === "T2") return code === "START_TRIAL_OR_UPGRADE" && href === "/pricing";
  return code === "UPGRADE_PLAN" && href === "/pricing";
}

function parseDiagnosisAllowanceError(body: unknown): DiagnosisAllowanceError | null {
  if (!isRecord(body) || body.code !== "DIAGNOSIS_ALLOWANCE_EXHAUSTED") return null;
  if (body.tier !== "T0" && body.tier !== "T1" && body.tier !== "T2" && body.tier !== "T3") {
    return null;
  }
  const tier = body.tier;
  if (typeof body.limit !== "number" || !Number.isSafeInteger(body.limit) || body.limit <= 0) {
    return null;
  }
  if (tier !== "T3" && body.limit !== FIXED_DIAGNOSIS_LIMITS[tier]) return null;
  if (body.remaining !== 0) return null;
  if (typeof body.resetsAt !== "string" || !Number.isFinite(Date.parse(body.resetsAt))) return null;
  if (!isRecord(body.nextAction)) return null;
  const { code, href, label } = body.nextAction;
  if (href !== "/signup" && href !== "/pricing") return null;
  if (!actionMatchesTier(tier, code, href)) return null;
  if (
    typeof label !== "string"
    || label.trim().length === 0
    || label.trim().length > 240
    || /[\u0000-\u001F\u007F]/.test(label)
  ) return null;

  return {
    tier,
    limit: body.limit,
    remaining: 0,
    resetsAt: body.resetsAt,
    nextAction: {
      code,
      label: label.trim(),
      href,
    },
  };
}

// Map an HTTP status + parsed body to friendly guidance. Tool context remains in
// the signature for callers, but a generic access response cannot infer a plan.
export function friendlyApiError(
  status: number,
  body: unknown,
  _tierForTool?: { tier: string; tool: string },
): string {
  const code = field(body, "code");
  const apiMsg = field(body, "error") ?? field(body, "message");

  if (status === 401 || code === "AUTH_REQUIRED") {
    return "Not authenticated. Set `DENPEX_API_KEY` (create one at https://denpex.com/dashboard → API Keys).";
  }
  if (status === 403 && code === "GPU_LIMIT_EXCEEDED") {
    const detected = field(body, "detected_gpus");
    const limit = field(body, "gpu_limit");
    const upgrade = field(body, "upgrade_required");
    return `Detected ${detected ?? "more"} GPUs in these logs, but your plan supports up to ${limit ?? "fewer"}. Upgrade to ${upgrade ?? "a higher plan"} at https://denpex.com/pricing to diagnose larger jobs.`;
  }
  if (status === 403 && (code === "TURNSTILE_REQUIRED" || code === "TURNSTILE_FAILED")) {
    return "The first no-key diagnosis is frictionless. Later anonymous diagnoses require a browser check that MCP cannot complete. Run it at https://denpex.com/#instant-diagnosis or set `DENPEX_API_KEY` from https://denpex.com/dashboard.";
  }
  if (status === 503 && code === "TURNSTILE_UNAVAILABLE") {
    return "Anonymous browser verification is unavailable. Set `DENPEX_API_KEY` from https://denpex.com/dashboard, or retry the browser tool later at https://denpex.com/#instant-diagnosis.";
  }
  if (status === 429 && code === "DIAGNOSIS_ALLOWANCE_EXHAUSTED") {
    const allowance = parseDiagnosisAllowanceError(body);
    if (allowance) {
      return `${allowance.tier} diagnosis allowance used (${allowance.limit} of ${allowance.limit}). Resets at ${allowance.resetsAt}. ${allowance.nextAction.label} https://denpex.com${allowance.nextAction.href}`;
    }
  }
  if (status === 402 || code === "UPGRADE_REQUIRED") {
    return "This request is not available for the current account. Review account options at https://denpex.com/pricing.";
  }
  // Daily free cap spent. Distinct from a transient rate limit: "pause a few
  // seconds" is actively wrong advice here (the user would retry forever).
  if (status === 429 && code === "SIGNUP_REQUIRED") {
    return "Today's 3 free diagnoses are used up, the cap resets tomorrow. Unlimited diagnoses on any paid plan: https://denpex.com/pricing";
  }
  if (status === 429) {
    return "Rate limited, pause a few seconds and try again.";
  }
  if (status === 400 && code === "INSUFFICIENT_DIAGNOSTIC_SIGNAL") {
    const guidance = field(body, "guidance");
    return guidance || "Paste the original failing lines, including an error, traceback, rank, scheduler event, GPU event, or system metric.";
  }
  if (status === 400) {
    return apiMsg ? `Request rejected: ${apiMsg}` : "Request rejected (bad input).";
  }
  if (status === 504) {
    return "Diagnosis timed out. Try again. Denpex already selects bounded causal evidence from long inputs.";
  }
  if (status >= 500) {
    return "Denpex service error. Please retry shortly; if it persists, contact support@denpex.com.";
  }
  return apiMsg ? `Denpex error (${status}): ${apiMsg}` : `Denpex error (${status}).`;
}

// Render any thrown value (DenpexError, network error, validation error) into one
// friendly string for a tool's error output.
export function describeError(err: unknown, tierForTool?: { tier: string; tool: string }): string {
  if (err instanceof DenpexError) {
    if (err.status === 0) {
      return `Could not reach Denpex (${err.message}). Check your network or DENPEX_API_URL.`;
    }
    return friendlyApiError(err.status, err.body, tierForTool);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
