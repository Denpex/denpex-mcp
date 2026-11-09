import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { resolveLogs, condenseLogs } from "../logs.js";
import { applyPrivacy } from "../privacy.js";
import { describeError } from "../errors.js";
import { toolText } from "./util.js";

// Check the CUDA / PyTorch / NCCL / driver combination in the logs against known-bad
// version pairings (Team+).
export function registerVersions(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "check_versions",
    {
      title: "Check for known-bad library/version combos",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Scan logs (or an environment dump like `pip list` / `nvidia-smi`) for CUDA / PyTorch / cuDNN / NCCL / driver versions that are known to be incompatible or buggy together, and get the recommended pin. Requires the Team plan or an active trial.",
      inputSchema: {
        logs: z.string().optional().describe("Paste logs or an environment dump."),
        file: z.string().optional().describe("Path to a log / environment file."),
        dir: z.string().optional().describe("Directory to scan for the newest log file."),
      },
    },
    async ({ logs, file, dir }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const resolved = await resolveLogs({ logs, file, dir });
        const res = await ctx.client.request<Record<string, unknown>>("/api/diagnose/version-advisory", {
          method: "POST",
          body: { logs: applyPrivacy(condenseLogs(resolved.text), ctx.config.privacy) },
        });
        // API envelope: { success, advisory: DetectorFinding }. The old code read
        // `res.detected` at the TOP level, which never exists, so this tool
        // answered "no known-bad combinations" for every log, including ones
        // matching real advisories (a silent false negative on a safety tool).
        const advisory = (res.advisory as Record<string, unknown> | undefined) ?? res;
        if (!advisory || advisory.detected !== true) {
          return toolText("No known-bad version combinations detected in these logs.");
        }
        const lines = ["**Version advisory:**", ""];
        if (typeof advisory.title === "string" && advisory.title) lines.push(`- **${advisory.title}**${advisory.severity ? ` (${advisory.severity})` : ""}`);
        if (typeof advisory.summary === "string" && advisory.summary) lines.push(advisory.summary);
        const evidence = advisory.evidence;
        if (Array.isArray(evidence) && evidence.length) {
          lines.push("", "**Evidence:**");
          for (const e of (evidence as unknown[]).slice(0, 6)) lines.push(`- ${String(e)}`);
        }
        if (typeof advisory.action === "string" && advisory.action) lines.push("", `**Fix:** ${advisory.action}`);
        if (typeof advisory.fallbackAction === "string" && advisory.fallbackAction) lines.push(`**If that fails:** ${advisory.fallbackAction}`);
        return toolText(lines.join("\n"));
      } catch (e) {
        return toolText(describeError(e, { tier: "Team", tool: "check_versions" }), true);
      }
    },
  );
}
