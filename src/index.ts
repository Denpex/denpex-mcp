// Entrypoint for the `denpex-mcp` bin. Connects the server over stdio (the
// transport every local MCP client. Claude Desktop, Cursor, Claude Code, uses).
//
// IMPORTANT: stdout is the JSON-RPC channel. Never write to it directly; all logs
// go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { runTrialCli } from "./trial.js";

async function main(): Promise<void> {
  if (process.argv[2] === "trial") {
    const code = await runTrialCli(process.argv.slice(3));
    process.exitCode = code;
    return;
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] MCP server v${SERVER_VERSION} ready (stdio).`);
}

main().catch((err) => {
  console.error("[denpex-mcp] fatal:", err);
  process.exitCode = 1;
});
