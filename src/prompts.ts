import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// A reusable prompt the client can surface (e.g. Claude Desktop's prompt picker)
// that drives the assistant straight to a Denpex diagnosis.
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "diagnose-training-crash",
    {
      title: "Diagnose a training crash",
      description: "Gather the crash log and run a Denpex diagnosis, then summarize the fix.",
      argsSchema: {
        logPath: z.string().optional().describe("Path to the crash log or directory, if known."),
      },
    },
    ({ logPath }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `My GPU training job crashed.` +
              (logPath ? ` The log is at \`${logPath}\`.` : "") +
              ` Use the Denpex \`diagnose_crash\` tool` +
              (logPath ? ` with file="${logPath}" (or dir if it's a folder)` : ` (pass the log via file, dir, or pasted logs)`) +
              ` to find the root cause and the fix. Then give me: (1) the failure type, (2) the single command or change to fix it, and (3) the one thing to do to prevent it next time. If it's a distributed/NCCL hang, also run \`analyze_cascade\` to find the culprit rank.`,
          },
        },
      ],
    }),
  );
}
