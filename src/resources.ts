import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listEncyclopedia, getEncyclopediaEntry } from "./offline/engine.js";

// Expose the evidence-gated failure encyclopedia as browsable, citable resources at
// denpex://failures/{slug}. Fully offline.
export function registerResources(server: McpServer): void {
  server.registerResource(
    "failure",
    new ResourceTemplate("denpex://failures/{slug}", {
      list: async () => ({
        resources: listEncyclopedia().map((e) => ({
          uri: `denpex://failures/${e.slug}`,
          name: e.title,
          description: e.category,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Denpex failure encyclopedia",
      description: "Known GPU/ML training failure classes with root causes and fixes.",
    },
    async (uri, variables) => {
      const slug = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      const e = slug ? getEncyclopediaEntry(slug) : null;
      if (!e) {
        return {
          contents: [{ uri: uri.href, mimeType: "text/markdown", text: `Unknown failure slug: ${slug ?? "(none)"}` }],
        };
      }
      const md = [
        `# ${e.title}`,
        `*Category: ${e.category}*`,
        "",
        "## Fix",
        e.action, ...(e.steps.length > 1 ? ["", "## Steps", ...e.steps.map((s, i) => `${i + 1}. ${s}`)] : []),
      ].join("\n");
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: md }] };
    },
  );
}
