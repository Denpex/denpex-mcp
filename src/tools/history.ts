import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { describeError } from "../errors.js";
import { toolText, fmtDate } from "./util.js";

// Recall the engineer's recent diagnoses (institutional memory across runs).
export function registerHistory(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "recent_diagnoses",
    {
      title: "List recent diagnoses",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description: "Show your most recent Denpex diagnoses, job name, failure type, confidence, and the fix, so you can recall what a prior crash was and how it was resolved.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("How many to return (default 10)."),
      },
    },
    async ({ limit }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const n = limit ?? 10;
        const res = await ctx.client.request<Record<string, unknown>>(`/api/diagnose/history?limit=${n}`);
        // API envelope key is `history` (was read as `diagnoses`, so this tool
        // told every customer "No diagnoses yet" forever). Read both for safety.
        const rows = ((res.history ?? res.diagnoses) as Record<string, unknown>[] | undefined) ?? [];
        if (rows.length === 0) return toolText("No diagnoses yet. Run `diagnose_crash` on a crash log to get started.");
        const lines: string[] = [`**Your last ${rows.length} diagnosis(es):**`, ""];
        for (const d of rows) {
          const when = fmtDate(d.created_at);
          const job = d.job_name ? ` · ${d.job_name}` : "";
          lines.push(`- **${d.failure_type ?? "UNKNOWN"}** (${d.confidence ?? "?"}%)${job}${when ? ` · ${when}` : ""}`);
          if (d.fix_summary) lines.push(`  ${d.fix_summary}`);
        }
        return toolText(lines.join("\n"));
      } catch (e) {
        return toolText(`Could not fetch history: ${describeError(e)}`, true);
      }
    },
  );
}
