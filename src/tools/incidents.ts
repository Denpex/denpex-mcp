import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { describeError } from "../errors.js";
import { toolText, fmtDate } from "./util.js";

// Surface the proactive incidents Denpex's closed-loop monitor caught and escalated
// on the fleet (Scale+).
export function registerIncidents(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_incidents",
    {
      title: "List proactive fleet incidents",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "List the GPU/training incidents Denpex's always-on monitor caught and auto-escalated on your fleet, failure type, cluster, escalation level, and the fix it applied. Requires the Scale plan or higher.",
      inputSchema: {},
    },
    async () => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const res = await ctx.client.request<Record<string, unknown>>("/api/monitor/incidents");
        const incidents = (res.incidents as Record<string, unknown>[] | undefined) ?? [];
        if (incidents.length === 0) {
          return toolText("No proactive incidents on your fleet right now. 🎉 (Denpex is monitoring; you'll be alerted if something escalates.)");
        }
        const lines: string[] = [`**${incidents.length} incident(s):**`, ""];
        for (const i of incidents) {
          const where = [i.cluster].filter(Boolean).join(" ");
          const lvl = i.level ? ` · L${i.level}` : "";
          lines.push(`### ${i.failure_type ?? "incident"}${where ? ` · ${where}` : ""}  ·  ${i.status ?? "open"}${lvl}`);
          if (i.occurrences) lines.push(`Seen ${i.occurrences}× (last ${fmtDate(i.last_seen)}).`);
          if (i.primary_fix) lines.push(`**Fix:** ${i.primary_fix}`);
          lines.push("");
        }
        return toolText(lines.join("\n").trim());
      } catch (e) {
        return toolText(describeError(e, { tier: "Scale", tool: "list_incidents" }), true);
      }
    },
  );
}
