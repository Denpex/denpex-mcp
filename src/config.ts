// Runtime configuration, read once from the environment the MCP client injects
// (see README for the per-client `env` blocks).
//
//   DENPEX_API_KEY   dpx_… key from denpex.com/dashboard → API Keys. Enables the
//                    cloud tools (LLM fallback, history, quota, fleet incidents).
//   DENPEX_API_URL   override the API base (default https://api.denpex.com).
//   DENPEX_LOCAL     1/true → diagnose ENTIRELY on-host (zero egress). Key optional.
//   DENPEX_PRIVACY   off (default) | mask | strict → client-side PII scrubbing of
//                    logs BEFORE anything leaves the machine.

export type PrivacyMode = "off" | "mask" | "strict";

export interface DenpexConfig {
  apiKey?: string;
  apiUrl: string;
  local: boolean;
  privacy: PrivacyMode;
}

const TRUTHY = /^(1|true|yes|on)$/i;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DenpexConfig {
  const apiKey = (env.DENPEX_API_KEY ?? "").trim() || undefined;
  const apiUrl = ((env.DENPEX_API_URL ?? "").trim() || "https://api.denpex.com").replace(/\/+$/, "");
  const local = TRUTHY.test((env.DENPEX_LOCAL ?? "").trim());

  const rawPrivacy = (env.DENPEX_PRIVACY ?? "").trim().toLowerCase();
  const privacy: PrivacyMode = rawPrivacy === "mask" || rawPrivacy === "strict" ? rawPrivacy : "off";

  return { apiKey, apiUrl, local, privacy };
}

// Cloud tools need a key unless the user opted into local-only mode. Centralized
// so every cloud tool surfaces the same actionable message.
export function requireCloud(config: DenpexConfig): string | null {
  if (config.apiKey) return null;
  return [
    "This tool needs a Denpex API key.",
    "Create one at https://denpex.com/dashboard → API Keys, then set `DENPEX_API_KEY` in your MCP client config.",
    "(Tip: `diagnose_crash` and `ask_followup` run locally without a key. Pass `cloud: true` to `diagnose_crash` to preview Cloud Deep Reasoning.)",
  ].join("\n");
}
