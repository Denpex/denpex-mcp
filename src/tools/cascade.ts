import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { resolveLogs, condenseLogs } from "../logs.js";
import { detectors } from "../offline/engine.js";
import { describeError } from "../errors.js";
import { toolText } from "./util.js";

// Localize a multi-rank NCCL hang to the rank that actually failed first, and route
// any Xid faults to the right node action. Deterministic and offline, free for
// everyone, instant, no logs leave the host.
export function registerCascade(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    "analyze_cascade",
    {
      title: "Find the culprit rank in a distributed hang",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        "Analyze a multi-rank distributed-training failure: find the rank that failed FIRST (the others usually just time out waiting on it) and route any GPU Xid faults to the correct node action (reset / reboot / RMA). Runs offline and instantly, provide the gathered per-rank logs via `logs`, `file`, or `dir`.",
      inputSchema: {
        logs: z.string().optional().describe("Paste the combined per-rank logs."),
        file: z.string().optional().describe("Path to a log file to read."),
        dir: z.string().optional().describe("Directory to scan for the newest log file."),
      },
    },
    async ({ logs, file, dir }) => {
      try {
        const resolved = await resolveLogs({ logs, file, dir });
        const text = condenseLogs(resolved.text);
        const found = detectors(text);
        if (found.length === 0) {
          return toolText(
            "No cross-rank cascade or Xid fault detected in these logs. If a job is hung, gather logs from ALL ranks (each rank writes its own file) so the first failure is visible, then re-run this tool.",
          );
        }
        const lines: string[] = [];
        if (resolved.source !== "inline") lines.push(`> Read \`${resolved.source}\`.`, "");
        for (const d of found) {
          lines.push(`### ${d.id === "cascade" ? "Cross-rank cascade" : "Xid → node action"}  ·  ${d.severity.toUpperCase()}`);
          lines.push(d.summary);
          lines.push("");
          lines.push(`**Action:** ${d.action}`);
          lines.push("");
        }
        return toolText(lines.join("\n").trim());
      } catch (e) {
        return toolText(`Could not analyze: ${describeError(e)}`, true);
      }
    },
  );
}
