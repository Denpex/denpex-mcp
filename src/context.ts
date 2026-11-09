// Shared dependencies handed to every tool: parsed config + the API client.
import type { DenpexConfig } from "./config.js";
import type { DenpexClient } from "./client.js";

export interface ToolContext {
  config: DenpexConfig;
  client: DenpexClient;
}
