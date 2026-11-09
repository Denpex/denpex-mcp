// Wire the Denpex MCP server: parse config, build the API client, and register
// every tool, resource, and prompt. Transport-agnostic, index.ts plugs in stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./config.js";
import { DenpexClient } from "./client.js";
import type { ToolContext } from "./context.js";

import { registerArtifactTools } from './tools/artifacts.js';
import { registerDiagnose } from "./tools/diagnose.js";
import { registerLookup } from "./tools/lookup.js";
import { registerCascade } from "./tools/cascade.js";
import { registerQuota } from "./tools/quota.js";
import { registerFollowup } from "./tools/followup.js";
import { registerVersions } from "./tools/versions.js";
import { registerIncidents } from "./tools/incidents.js";
import { registerHistory } from "./tools/history.js";
import { registerFeedback } from "./tools/feedback.js";
import { registerFleetTools } from "./tools/fleet.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

// Re-exported so existing importers keep working. The literals live in
// version.ts, which is import-free so the drift guard can read it, see the note
// there for the four releases this split exists to prevent. Imported as well as
// re-exported: `export ... from` alone creates no local binding, and both names
// are used below.
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
export { SERVER_NAME, SERVER_VERSION };

export function createServer(): McpServer {
  const config = loadConfig();
  const client = new DenpexClient(config);
  const ctx: ToolContext = { config, client };

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Core (work offline / on every plan)
  registerDiagnose(server, ctx);
  registerArtifactTools(server);
  registerLookup(server, ctx);
  registerCascade(server, ctx);

  // Cloud (need a key; gated tools degrade to friendly upgrade messages)
  registerQuota(server, ctx);
  registerFollowup(server, ctx);
  registerVersions(server, ctx);
  registerIncidents(server, ctx);
  registerHistory(server, ctx);
  // WO-3.7: closes the learning loop, the agent is the one caller that reliably
  // knows whether the fix worked.
  registerFeedback(server, ctx);
  // WO-3.7: preflight, the two "it worked yesterday" tools, checkpoint validation
  // and the fleet reads. All thin wrappers over routes that already existed and were
  // simply unreachable from an agent.
  registerFleetTools(server, ctx);

  // Resources + prompt
  registerResources(server);
  registerPrompts(server);

  return server;
}
