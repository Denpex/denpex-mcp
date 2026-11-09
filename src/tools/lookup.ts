import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { engineInfo, searchEncyclopedia } from "../offline/engine.js";
import { toolText } from "./util.js";

// Search the same generated encyclopedia snapshot the canonical engine bundles. Fully offline,
// no quota cost, the fast "what does Xid 79 mean?" lookup.
export function registerLookup(server: McpServer, _ctx: ToolContext): void {
  const classes = engineInfo().classes;
  server.registerTool(
    "lookup_failure",
    {
      title: "Look up a known GPU/ML failure",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      description:
        `Search Denpex's bundled ${classes}-class failure encyclopedia by error code, keyword, or symptom (e.g. 'Xid 79', 'NCCL timeout', 'loss is NaN', 'CUDA out of memory'). Returns the most relevant known failures with their fixes. Works fully offline and costs no quota. Use \`diagnose_crash\` instead when you have a full crash log.`,
      inputSchema: {
        query: z.string().describe("Error code, message, or symptom to look up."),
        limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)."),
      },
    },
    async ({ query, limit }) => {
      const hits = searchEncyclopedia(query, limit ?? 5);
      if (hits.length === 0) {
        return toolText(
          `No known failure matched “${query}”. Try \`diagnose_crash\` with the full log for a deeper (LLM-backed) analysis.`,
        );
      }
      const lines: string[] = [`Found ${hits.length} relevant failure class(es) for “${query}”:`, ""];
      for (const h of hits) {
        lines.push(`### ${h.title}  ·  ${h.category}  ·  ~${h.confidence}% match`);
        lines.push(`**Fix:** ${h.action}`);
        if (h.steps.length > 1) {
          lines.push("**Steps:**");
          h.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
        }
        if (h.evidence.length) lines.push(`_${h.evidence.join(" · ")}_`);
        lines.push(`_Reference: denpex://failures/${h.slug}_`);
        lines.push("");
      }
      return toolText(lines.join("\n").trim());
    },
  );
}
