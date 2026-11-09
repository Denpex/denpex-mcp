// WO-3.7, `submit_fix_outcome`. The single biggest omission in the MCP surface.
//
// An agent applies the fix, observes whether the job recovered, and until now had no
// way to tell Denpex. That matters more here than anywhere else in the product: the
// agent is the ONE caller that reliably knows the answer. A human closes the tab; an
// agent is still holding the job handle when the next step succeeds or fails.
//
// Downstream, `getDynamicPrior` reads exactly this table to weight the next diagnosis
// of the same failure class, and `deepDiagnose` grounds the LLM on "this fix worked
// 9/10 times". With the console's own feedback path broken until WO-1.3, the learning
// loop had no working input at all, this closes it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { describeError } from "../errors.js";
import { fixOutcomeOutputShape } from "../schemas.js";
import { toolText, toolResult } from "./util.js";

export function registerFeedback(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "submit_fix_outcome",
    {
      title: "Report whether a Denpex fix worked",
      // Not read-only: this writes a feedback row. Idempotent: the endpoint upserts on
      // (diagnosisId, user), so re-reporting corrects rather than duplicates.
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Report back whether a Denpex fix actually resolved the failure. Call this after you apply a fix from `diagnose_crash` and observe the result, it is the ONLY way the engine learns, and it directly improves the next diagnosis of this failure class for you and everyone else. Pass the `diagnosisId` printed at the bottom of the diagnosis. If the fix did not work, say what actually happened in `note` (and `newFix` if you found the real one), a specific negative is worth more than a vague positive.",
      inputSchema: {
        diagnosisId: z.string().describe("The `diagnosisId` from the diagnosis you acted on."),
        outcome: z
          .enum(["worked", "did_not_work"])
          .describe("`worked` = the failure is resolved and the job is progressing. `did_not_work` = it recurred or the fix did not apply."),
        note: z
          .string()
          .optional()
          .describe("What actually happened. On a `did_not_work`, this is the most valuable field in the call, say what the log showed after the fix."),
        newFix: z.string().optional().describe("If you found the real fix, what was it?"),
      },
      outputSchema: fixOutcomeOutputShape,
    },
    async ({ diagnosisId, outcome, note, newFix }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        await ctx.client.request<Record<string, unknown>>("/api/diagnose/feedback", {
          method: "POST",
          // Field names match the endpoint's contract exactly: { diagnosisId, outcome,
          // note?, newFix? }. The docs page documented `{id, helpful}`, which 400s -
          // see WO-3.12.
          body: { diagnosisId, outcome, ...(note ? { note } : {}), ...(newFix ? { newFix } : {}) },
        });
        const message =
          outcome === "worked"
            ? `Recorded: the fix for ${diagnosisId} worked. This raises the engine's prior for this failure class.`
            : `Recorded: the fix for ${diagnosisId} did NOT work.${newFix ? " Your replacement fix was saved with it." : ""} Future diagnoses of this class will weight against it.`;
        return toolResult(message, { recorded: true, diagnosisId, outcome, message });
      } catch (e) {
        return toolText(
          `Could not record the outcome: ${describeError(e, { tier: "Team", tool: "submit_fix_outcome" })}`,
          true,
        );
      }
    },
  );
}
