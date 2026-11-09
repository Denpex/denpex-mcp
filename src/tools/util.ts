// Shared helpers for tool return values.
//
// WO-3.6: every tool used to return a single markdown text block and nothing else, so
// an agent could not branch on `confidenceBand === "low"` or iterate
// `rankedHypotheses`, it had to regex prose. `toolResult` attaches
// `structuredContent` alongside the same human-readable text, which is what the MCP
// output-schema contract expects: the text block stays for humans and for clients that
// predate structured output, and the object is what a program reads.
//
// IMPORTANT (MCP protocol): a tool that declares an `outputSchema` MUST return
// `structuredContent` validating against it. Use `toolResult` for those and plain
// `toolText` for tools that declare no schema. An error return carries no
// `structuredContent`, an error is not a result, which is why `toolText(msg, true)`
// stays the error path even on schema-bearing tools.
export function toolText(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}),
  };
}

export function toolResult<T extends Record<string, unknown>>(text: string, structuredContent: T) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

export function fmtDate(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 16).replace("T", " ");
}
