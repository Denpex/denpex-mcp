// Client-side PII scrubbing. Runs on the engineer's machine BEFORE any log text
// is sent to the Denpex API, so even cloud mode is safe for privacy-sensitive
// labs and data centers. `maskPII` mirrors worker/detectors.ts:maskPII so the
// redaction is identical to what the server would do.
import type { PrivacyMode } from "./config.js";

export function maskPII(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[AWS_KEY]")
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[API_KEY]")
    .replace(/\bdp[kx]_[A-Za-z0-9]{8,}\b/g, "[DENPEX_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [TOKEN]")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[JWT]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+/g, "/[USER]");
}

// `strict` additionally redacts MAC addresses and internal node FQDNs (e.g.
// gpu-047.cluster.internal). The hostname rule deliberately requires a digit AND
// 3+ dot-separated labels so it never mangles library paths like torch.cuda.amp.
export function applyPrivacy(text: string, mode: PrivacyMode): string {
  if (mode === "off") return text;
  let out = maskPII(text);
  if (mode === "strict") {
    out = out
      .replace(/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/gi, "[MAC]")
      .replace(/\b(?=[a-z0-9.-]*[a-z])(?=[a-z0-9.-]*\d)[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z][a-z0-9-]*\b/gi, "[HOST]");
  }
  return out;
}
