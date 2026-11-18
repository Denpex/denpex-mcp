import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { resolveLogs, condenseLogs, assertEnoughLog } from "../logs.js";
import { applyPrivacy } from "../privacy.js";
import { describeError, DenpexError } from "../errors.js";
import { toolText } from "./util.js";

interface DeepResearchSource {
  id: string;
  url: string;
  title: string;
  via: string;
  round: number;
}

interface DeepResearchReport {
  status?: string;
  summary?: string;
  rootCause?: { explanation?: string; owner?: string; sources?: string[] } | null;
  fixedIn?: Array<{ component?: string; version?: string; sources?: string[] }>;
  likelyCauses?: Array<{ cause?: string; sources?: string[]; conditions?: string; confidence?: string }>;
  fixesReportedByOthers?: Array<{ fix?: string; sources?: string[]; worksWhen?: string; didNotWorkWhen?: string; risk?: string }>;
  conflicts?: Array<{ claim?: string; sources?: string[] }>;
  gaps?: string[];
  nextChecks?: string[];
  verification?: string[];
  scope?: string;
  distinguishingCheck?: string;
  model?: string | null;
}

interface DeepResearchPayload {
  id?: string;
  phase?: string;
  seconds?: number;
  stopReason?: string | null;
  report?: DeepResearchReport | null;
  sources?: DeepResearchSource[];
  coverage?: {
    queriesRun?: number;
    pagesRead?: number;
    roundsCompleted?: number;
    domains?: string[];
  };
  remaining?: number;
  limit?: number;
  error?: string;
}

function fmtCite(ids: string[] | undefined): string {
  return Array.isArray(ids) && ids.length ? ` [${ids.join(", ")}]` : "";
}

function formatDeepResearchMarkdown(data: DeepResearchPayload, anonymous: boolean): string {
  const lines: string[] = [];
  const cov = data.coverage;
  const headerMeta = [
    data.phase ? `phase=${data.phase}` : null,
    typeof data.seconds === "number" ? `${data.seconds}s` : null,
    typeof cov?.pagesRead === "number" ? `${cov.pagesRead} pages read` : null,
    typeof cov?.roundsCompleted === "number" ? `${cov.roundsCompleted} rounds` : null,
  ].filter(Boolean).join(" | ");

  lines.push(`# Deep Research Investigation${data.id ? ` (${data.id})` : ""}`);
  if (headerMeta) lines.push(`_${headerMeta}_`);

  const report = data.report;
  if (report?.summary) {
    lines.push("", "## Summary", report.summary);
  }
  if (report?.rootCause?.explanation) {
    lines.push(
      "",
      "## Root Cause",
      `${report.rootCause.explanation}${report.rootCause.owner ? ` (owner: \`${report.rootCause.owner}\`)` : ""}${fmtCite(report.rootCause.sources)}`,
    );
  }
  if (report?.fixedIn?.length) {
    lines.push("", "## Fixed In");
    for (const item of report.fixedIn) {
      lines.push(`- **${item.component || "component"}**: ${item.version || "unknown"}${fmtCite(item.sources)}`);
    }
  }
  if (report?.likelyCauses?.length) {
    lines.push("", "## Likely Causes");
    for (const cause of report.likelyCauses) {
      lines.push(`- **(${cause.confidence || "unknown"})** ${cause.cause || ""}${cause.conditions ? ` - _When:_ ${cause.conditions}` : ""}${fmtCite(cause.sources)}`);
    }
  }
  if (report?.fixesReportedByOthers?.length) {
    lines.push("", "## Fixes Reported by Others");
    for (const fix of report.fixesReportedByOthers) {
      const details = [
        fix.worksWhen ? `works when: ${fix.worksWhen}` : null,
        fix.didNotWorkWhen ? `did not work when: ${fix.didNotWorkWhen}` : null,
        fix.risk ? `risk: ${fix.risk}` : null,
      ].filter(Boolean).join("; ");
      lines.push(`- ${fix.fix || ""}${details ? ` (${details})` : ""}${fmtCite(fix.sources)}`);
    }
  }
  if (report?.distinguishingCheck) {
    lines.push("", "## Distinguishing Check", report.distinguishingCheck);
  }
  if (report?.nextChecks?.length) {
    lines.push("", "## Next Checks", ...report.nextChecks.map((c) => `- ${c}`));
  }
  if (report?.verification?.length) {
    lines.push("", "## Verification", ...report.verification.map((v) => `- ${v}`));
  }
  if (report?.conflicts?.length) {
    lines.push("", "## Conflicting Findings", ...report.conflicts.map((c) => `- ${c.claim || ""}${fmtCite(c.sources)}`));
  }
  if (report?.gaps?.length) {
    lines.push("", "## Open Gaps", ...report.gaps.map((g) => `- ${g}`));
  }
  if (data.sources?.length) {
    lines.push("", "## Sources (Obscura & Web)");
    for (const src of data.sources.slice(0, 20)) {
      const label = src.title || src.url;
      lines.push(`- [${src.id}] ${label} (${src.via}, round ${src.round}) - ${src.url}`);
    }
  }
  if (anonymous && typeof data.remaining === "number" && typeof data.limit === "number") {
    lines.push("", `_Free cloud quota remaining today: ${data.remaining} / ${data.limit}._`);
  }
  return lines.join("\n");
}

export function registerDeepResearch(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "deep_research_crash",
    {
      title: "Deep Research a GPU/ML crash",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Run multi-round web and Obscura headless page research on a GPU/ML crash to cross-check GitHub issues, release fixes, vendor advisories, and engineering write-ups with cited sources. Disabled when DENPEX_LOCAL=1.",
      inputSchema: {
        logs: z.string().optional().describe("Paste the crash log or stderr (min 20 characters)."),
        file: z.string().optional().describe("Path to a log file to read from disk."),
        dir: z.string().optional().describe("Directory to scan for the newest *.err / *.log / *.out / *.txt."),
        failureType: z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/).optional().describe("Optional known failure class, e.g. NCCL_TIMEOUT."),
        environment: z.string().max(8_000).optional().describe("Optional cluster/library environment versions (PyTorch, CUDA, NCCL, driver)."),
      },
    },
    async ({ logs, file, dir, failureType, environment }) => {
      if (ctx.config.local) {
        return toolText(
          "Denpex is running in local zero-egress mode (DENPEX_LOCAL=1), so Deep Research with Obscura and web retrieval is disabled. Unset DENPEX_LOCAL or use `diagnose_crash` for local diagnosis.",
          true,
        );
      }

      try {
        const resolved = await resolveLogs({ logs, file, dir });
        assertEnoughLog(resolved.text);
        const scrubbed = applyPrivacy(resolved.text, ctx.config.privacy);
        const prepared = condenseLogs(scrubbed).slice(-190_000);
        const scrubbedEnv = environment ? applyPrivacy(environment, ctx.config.privacy).slice(0, 8_000) : undefined;

        const endpoint = ctx.config.apiKey ? "/api/research/deep" : "/api/research/deep/anon";
        const payload = await ctx.client.request<DeepResearchPayload>(endpoint, {
          method: "POST",
          body: {
            logs: prepared,
            ...(failureType ? { failureType } : {}),
            ...(scrubbedEnv ? { environment: scrubbedEnv } : {}),
          },
          timeoutMs: 900_000,
        });

        if (payload?.error) {
          return toolText(`Deep research failed: ${payload.error}`, true);
        }
        return toolText(formatDeepResearchMarkdown(payload, !ctx.config.apiKey));
      } catch (e) {
        if (e instanceof DenpexError && e.status === 403 && e.body && typeof e.body === "object") {
          const code = (e.body as Record<string, unknown>).code;
          if (code === "PAID_PLAN_REQUIRED") {
            return toolText(
              "Authenticated Deep Research requires a Team+ plan (`https://denpex.com/pricing`). Without an API key, `deep_research_crash` uses the 3/day anonymous allowance.",
              true,
            );
          }
          if (code === "TURNSTILE_REQUIRED" || code === "TURNSTILE_FAILED") {
            return toolText(
              "Additional anonymous Deep Research runs today require a browser Turnstile check on https://denpex.com, or configure DENPEX_API_KEY for a paid account.",
              true,
            );
          }
        }
        return toolText(`Deep research failed: ${describeError(e)}`, true);
      }
    },
  );
}
