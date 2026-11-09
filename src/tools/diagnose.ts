import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolContext } from "../context.js";
import { resolveLogs, condenseLogs, assertEnoughLog } from "../logs.js";
import { applyPrivacy } from "../privacy.js";
import { canonicalOfflineEnvelope, runCanonicalOfflineDiagnosis } from "../offline/canonical-engine.mjs";
import { viewFromCanonicalOffline, viewFromCloud, renderDiagnosis, structuredDiagnosis } from "../format.js";
import { diagnosisOutputShape } from "../schemas.js";
import { describeError, DenpexError } from "../errors.js";
import { toolText, toolResult } from "./util.js";
import { followupEvidenceKey, rememberDiagnosis, rememberLocalDiagnosis } from "../followup-state.js";

// Anonymous refinement capabilities are scoped to one MCP process and keyed by a
// digest of the privacy-scrubbed original evidence. Keep only a small LRU-ish window:
// the opaque token belongs to the API, while the logs themselves never become map keys.
const anonymousRefinementTokens = new Map<string, string>();
function refinementKey(logs: string): string {
  return createHash("sha256").update(logs).digest("hex");
}
function rememberRefinement(key: string, token: string): void {
  anonymousRefinementTokens.delete(key);
  anonymousRefinementTokens.set(key, token);
  while (anonymousRefinementTokens.size > 50) {
    const oldest = anonymousRefinementTokens.keys().next().value as string | undefined;
    if (!oldest) break;
    anonymousRefinementTokens.delete(oldest);
  }
}

// The flagship tool. Reads logs from inline text / a file / a directory, scrubs
// PII client-side, then diagnoses via the cloud (LLM fallback on novel errors) or
// fully offline only when explicitly requested. Tier limits (GPU caps, free quota) are enforced server-side and
// surfaced as friendly upgrade messages.
export function registerDiagnose(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "diagnose_crash",
    {
      title: "Diagnose a GPU/ML crash",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Diagnose a GPU/ML training crash (CUDA OOM, NCCL timeout, Xid fault, NaN loss, checkpoint corruption, etc.) and get the root cause plus an escalating fix (primary → fallback → emergency). Provide ONE of: `logs` (paste), `file` (path to a log), or `dir` (folder to scan for the newest *.err/*.log). Runs the canonical deterministic engine locally by default (unlimited free local runs), and escalates to the Denpex cloud when DENPEX_API_KEY is configured or cloud: true is passed. Or run fully offline with DENPEX_LOCAL=1.",
      inputSchema: {
        cloud: z.boolean().optional().describe("Set to true to explicitly request a Cloud Deep Reasoning review when running without an API key."),
        logs: z.string().optional().describe("Paste the crash log or stderr. Terse machine events such as Xid 79 are accepted."),
        file: z.string().optional().describe("Path to a log file to read from disk."),
        dir: z.string().optional().describe("Directory to scan for the newest *.err / *.log / *.out / *.txt."),
        jobName: z.string().optional().describe("Optional job or run name (saved to history)."),
        runtimeHours: z.number().optional().describe("Hours the job ran before crashing (enables a $ cost estimate)."),
        gpuRate: z.number().optional().describe("Your effective $/GPU-hour (enables a $ cost estimate)."),
        // ── WO-3.6 ─────────────────────────────────────────────────────────────
        // The engine's deterministic tiers read hardware telemetry, source context
        // and rank topology, and `/api/diagnose` has always accepted all three. The
        // MCP posted only {logs, jobName, runtimeHours, gpuRate}, so an agent, the
        // one caller that CAN run `nvidia-smi` and `dmesg` on the failing node before
        // asking, was the one caller that could not send the answer.
        telemetry: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Hardware telemetry captured from the failing node. Keys the engine reads: `dmesg` (output of `dmesg -T`), `nvidia_smi` (`nvidia-smi -q`), `ibstat`. Sending these turns an ambiguous NCCL timeout into a specific Xid/ECC verdict, and, just as importantly, lets the engine EXONERATE the GPU when the counters are clean.",
          ),
        codeContext: z
          .record(z.string(), z.string())
          .optional()
          .describe("Relevant source files as { path: contents }. Only send real files you read, the engine never fabricates code context, and neither should you."),
        topologyMap: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe("Rank → node placement as { nodeName: [rank...] }, e.g. from the launcher. Lets the engine map a failing rank to a physical node and GPU."),
        operatorAnswers: z
          .array(z.object({
            questionId: z.string().optional(),
            optionId: z.string().optional(),
            kind: z.enum(["fact", "action"]).optional(),
            question: z.string().optional(),
            answer: z.string(),
          }))
          .max(12)
          .optional()
          .describe("Answers from a previous diagnose_crash result. Send the full answer history with the same original logs. Selecting an ACTION asks Denpex for that evidence; it is not treated as the result of the check."),
        refinementToken: z
          .string()
          .max(160)
          .optional()
          .describe("Anonymous-only capability returned by the prior diagnosis. Normally cached automatically in this MCP process; pass it explicitly after a process restart."),
      },
      outputSchema: diagnosisOutputShape,
    },
    async ({ cloud, logs, file, dir, jobName, runtimeHours, gpuRate, telemetry, codeContext, topologyMap, operatorAnswers, refinementToken }) => {
      try {
        const resolved = await resolveLogs({ logs, file, dir });
        assertEnoughLog(resolved.text);

        const privacyFilteredOriginal = applyPrivacy(resolved.text, ctx.config.privacy);
        const prepared = condenseLogs(privacyFilteredOriginal);
        const preparedRefinementKey = refinementKey(prepared);
        const sourceNote = resolved.source === "inline" ? undefined : `Read \`${resolved.source}\`.`;

        // Zero-egress is explicit. Without a key, use the same canonical anonymous
        // engine as the homepage's no-key test drive; silently falling back to
        // the smaller offline matcher made MCP disagree with Console/API for the
        // same log and hid that downgrade from first-time users.
        if (ctx.config.local) {
          if (operatorAnswers?.length) {
            return toolText("Offline mode cannot re-run the evidence-bound conversational reasoner. Run the selected check, append its actual output to the original logs, and call `diagnose_crash` again. No action selection was treated as evidence.", true);
          }
          const outcome = await runCanonicalOfflineDiagnosis(prepared, { telemetry, codeContext, topologyMap });
          const localView = viewFromCanonicalOffline(
            canonicalOfflineEnvelope(outcome),
            sourceNote ?? 'Full deterministic engine ran on-host; cloud LLM/research enrichment was disabled.',
          );
          rememberLocalDiagnosis(followupEvidenceKey(privacyFilteredOriginal), localView);
          return toolResult(renderDiagnosis(localView), structuredDiagnosis(localView));
        }

        const preferLocalWithoutKey = !ctx.config.apiKey && !cloud;
        if (preferLocalWithoutKey) {
          if (operatorAnswers?.length) {
            return toolText("Local mode cannot re-run the evidence-bound conversational reasoner without a cloud pass. Pass `cloud: true` or set `DENPEX_API_KEY` to submit operatorAnswers, or append the new command output to your logs and call `diagnose_crash` again.", true);
          }
          const outcome = await runCanonicalOfflineDiagnosis(prepared, { telemetry, codeContext, topologyMap });
          const localView = viewFromCanonicalOffline(
            canonicalOfflineEnvelope(outcome),
            sourceNote ?? "Local-first canonical engine ran on-host (unlimited free local diagnosis, no log uploaded).",
          );
          rememberLocalDiagnosis(followupEvidenceKey(privacyFilteredOriginal), localView);
          return toolResult(renderDiagnosis(localView), structuredDiagnosis(localView));
        }

        // Telemetry is log-shaped free text from the node, scrub it on the same
        // path the logs take, or a hostname/IP the privacy filter strips from
        // `logs` walks out inside `telemetry.dmesg` instead.
        const preparedTelemetry = telemetry
          ? Object.fromEntries(Object.entries(telemetry).map(([k, v]) => [k, applyPrivacy(String(v), ctx.config.privacy)]))
          : undefined;

        // ── LAUNCH AUDIT: codeContext and topologyMap bypassed the privacy filter ──
        // This module's contract, stated at the top of privacy.ts, is that scrubbing
        // "runs on the engineer's machine BEFORE any log text is sent to the Denpex
        // API, so even cloud mode is safe for privacy-sensitive labs and data
        // centers." `logs` and `telemetry` honoured it; these two did not, and they
        // are the two payloads MOST likely to carry exactly what the filter exists to
        // remove. codeContext is raw source, the canonical home of a hardcoded key,
        // a connection string, an internal hostname, an author's email. topologyMap's
        // KEYS are node names, `gpu-047.cluster.internal` is the literal example in
        // the strict-mode hostname rule. A privacy-sensitive lab running
        // DENPEX_PRIVACY=strict was told its hostnames never leave the machine, and
        // then shipped them as JSON object keys.
        //
        // Keys are scrubbed as well as values: a path like /home/asmith/train.py
        // identifies a person just as well as the file's contents do.
        const scrub = (s: string) => applyPrivacy(s, ctx.config.privacy);

        // Scrubbing KEYS can collide, strict mode rewrites every internal FQDN to the
        // single token [HOST], so `{gpu-01.c.internal: [...], gpu-02.c.internal: [...]}`
        // would collapse to ONE key and Object.fromEntries would keep only the last.
        // That is worse than leaking: the engine would be told two nodes are one node
        // and would attribute a cross-node fault to a single box. Disambiguate instead,
        // so cardinality and the rank→node mapping survive redaction intact.
        const scrubKeys = <T,>(obj: Record<string, T>, mapValue: (v: T) => T): Record<string, T> => {
          const out: Record<string, T> = {};
          const used = new Map<string, number>();
          for (const [k, v] of Object.entries(obj)) {
            const base = scrub(k);
            const n = (used.get(base) ?? 0) + 1;
            used.set(base, n);
            out[n === 1 ? base : `${base}-${n}`] = mapValue(v);
          }
          return out;
        };

        const preparedCodeContext = codeContext
          ? scrubKeys(codeContext, (v) => scrub(String(v)))
          : undefined;
        const preparedTopologyMap = topologyMap
          ? scrubKeys(topologyMap, (ranks) => (Array.isArray(ranks) ? ranks : []).map((r) => scrub(String(r))))
          : undefined;

        const endpoint = ctx.config.apiKey ? "/api/diagnose" : "/api/diagnose/anon";
        const activeRefinementToken = refinementToken ?? anonymousRefinementTokens.get(preparedRefinementKey);
        if (operatorAnswers?.length && !ctx.config.apiKey && !activeRefinementToken) {
          return toolText("Anonymous clarification is missing the refinement token from the prior diagnosis. Re-run diagnose_crash with the same original logs, then answer the questions it returns. No answer was submitted or charged.", true);
        }
        
        let payload: Record<string, unknown>;
        try {
          payload = await ctx.client.request<Record<string, unknown>>(endpoint, {
            method: "POST",
            body: {
              logs: prepared,
              jobName,
              runtimeHours,
              gpuRate, ...(preparedTelemetry ? { telemetry: preparedTelemetry } : {}), ...(preparedCodeContext ? { codeContext: preparedCodeContext } : {}), ...(preparedTopologyMap ? { topologyMap: preparedTopologyMap } : {}), ...(operatorAnswers?.length ? { operatorAnswers } : {}),
            }, ...(operatorAnswers?.length && !ctx.config.apiKey && activeRefinementToken ? {
              headers: {
                "X-Denpex-Followup": "1",
                "X-Denpex-Refinement": activeRefinementToken,
              },
            } : {}),
            // Outlive the server's bounded review and transport windows.
            timeoutMs: 600_000,
          });
        } catch (apiError) {
          if (!ctx.config.apiKey && apiError instanceof DenpexError && (apiError.status === 401 || apiError.status === 403 || apiError.status === 429)) {
            if (operatorAnswers?.length) {
              return toolText("Anonymous cloud session exhausted or requires browser check. Local mode cannot process operatorAnswers. Run the selected check, append its actual output to the original logs, and call `diagnose_crash` without operatorAnswers, or configure `DENPEX_API_KEY`.", true);
            }
            const outcome = await runCanonicalOfflineDiagnosis(prepared, { telemetry, codeContext, topologyMap });
            const localView = viewFromCanonicalOffline(
              canonicalOfflineEnvelope(outcome),
              sourceNote ? sourceNote + " Anonymous cloud pass requires API key or browser check; canonical local engine ran on-host instead." : "Anonymous cloud pass requires API key or browser check; canonical local engine ran on-host instead.",
            );
            rememberLocalDiagnosis(followupEvidenceKey(privacyFilteredOriginal), localView);
            return toolResult(renderDiagnosis(localView), structuredDiagnosis(localView));
          }
          throw apiError;
        }

        if (!ctx.config.apiKey && typeof payload.refinementToken === "string" && payload.refinementToken) {
          rememberRefinement(preparedRefinementKey, payload.refinementToken);
        }
        if (typeof payload.diagnosisId === "string") {
          rememberDiagnosis(followupEvidenceKey(privacyFilteredOriginal), payload.diagnosisId);
        }
        const view = viewFromCloud(payload, sourceNote);
        return toolResult(renderDiagnosis(view), structuredDiagnosis(view));
      } catch (e) {
        return toolText(`Could not diagnose: ${describeError(e)}`, true);
      }
    },
  );
}
