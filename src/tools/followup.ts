import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { condenseLogs } from "../logs.js";
import { applyPrivacy } from "../privacy.js";
import { describeError } from "../errors.js";
import { toolText, toolResult } from "./util.js";
import { viewFromCloud, viewFromCanonicalOffline, renderDiagnosis, structuredDiagnosis } from '../format.js';
import { followupEvidenceKey, recallDiagnosis, recallLocalDiagnosis, rememberLocalDiagnosis, answerLocalFollowUp } from "../followup-state.js";
import { canonicalOfflineEnvelope, runCanonicalOfflineDiagnosis } from "../offline/canonical-engine.mjs";

// Conversational follow-up on a diagnosis (Team+). Keeps a conversationId so the
// thread is continued and saved to the dashboard.
export function registerFollowup(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "ask_followup",
    {
      title: "Ask a follow-up about a diagnosis",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Ask the Denpex diagnostician a follow-up question about a crash, clarify the fix, explore an alternative, or dig deeper. Pass the original `logs` and your `question`; pass back the `conversationId` from a previous reply to continue the thread. Requires the Team plan or an active trial.",
      inputSchema: {
        question: z.string().describe("Your follow-up question."),
        logs: z.string().describe("The original crash logs the question is about."),
        conversationId: z.string().optional().describe("From a previous reply, to continue the same thread."),
        history: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
          .optional()
          .describe("Prior turns of this conversation, oldest first."),
      },
    },
    async ({ question, logs, conversationId, history }) => {
      try {
        const preferLocal = ctx.config.local || !ctx.config.apiKey;
        const privacyFilteredOriginal = applyPrivacy(logs, ctx.config.privacy);
        const evKey = followupEvidenceKey(privacyFilteredOriginal);

        if (preferLocal) {
          let localView = recallLocalDiagnosis(evKey);
          if (!localView) {
            const outcome = await runCanonicalOfflineDiagnosis(condenseLogs(privacyFilteredOriginal), {});
            localView = viewFromCanonicalOffline(canonicalOfflineEnvelope(outcome));
            rememberLocalDiagnosis(evKey, localView);
          }
          
          const answer = answerLocalFollowUp(question, localView);
          const text = [
            answer,
            "",
            "_Configure `DENPEX_API_KEY` from https://denpex.com/dashboard or start a 30-day Team Trial at https://denpex.com/pricing for multi-turn generative cloud follow-ups._"
          ].join('\n');
          
          return toolResult(text, { ...structuredDiagnosis(localView), localFollowUp: answer, conversationId: conversationId ?? null });
        }

        const blocked = requireCloud(ctx.config);
        if (blocked) return toolText(blocked, true);

        const turns = [...(history ?? []), { role: "user" as const, content: question }].map(turn=>({...turn,content:applyPrivacy(turn.content,ctx.config.privacy)}));
        const diagnosisId = recallDiagnosis(evKey);
        if (!diagnosisId) {
          return toolText("No diagnosis identity is available for these logs. Run diagnose_crash first in this MCP process, then ask the follow-up with the same original logs.", true);
        }
        const reply = await ctx.client.request<Record<string, unknown>>("/api/diagnose/chat", {
          method: "POST",
          body: {
            logs: condenseLogs(privacyFilteredOriginal, 50_000),
            history: turns,
            conversationId,
            diagnosisId,
          },
          // Follow-ups use the same complete-response deadline as diagnosis.
          timeoutMs: 600_000,
        });
        if(!reply.reply || typeof reply.reply!=='object' || Array.isArray(reply.reply))return toolText('No complete follow-up report returned. Retry without treating this as a diagnosis.',true);
        const r = reply.reply as Record<string, unknown>;
        const view = viewFromCloud({...r,fix:r,forensicReport:r.forensicReport,diagnosisId,meta:{failureType:r.failureType,confidence:r.confidence}});
        const lines = [renderDiagnosis(view)];
        const cid = reply.conversationId;
        if (typeof cid === "string") lines.push("", `_conversationId: ${cid} (pass this back to continue)_`);
        return toolResult(lines.join('\n').trim(), {...structuredDiagnosis(view),conversationId:typeof cid==='string'?cid:null});
      } catch (e) {
        return toolText(describeError(e, { tier: "Team", tool: "ask_followup" }), true);
      }
    },
  );
}
