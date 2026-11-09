// Identity the MCP server reports to every client in its `initialize` response
// and its stderr banner.
//
// WHY THIS IS ITS OWN FILE. It lived in server.ts as a literal and drifted: the
// package published 0.2.1, 0.2.2, 0.2.3, 0.2.4 while every client was still told
// `denpex@0.2.0`. Four releases of silent drift, found 2026-08-17 by driving the
// published server over stdio and reading the handshake back.
//
// That is the same failure ENGINE_VERSION has a fingerprint for, and it costs the
// same thing: a customer reports a bug against "0.2.0" because that is what their
// client shows, and the support trail leads to code they are not running.
//
// Kept import-free on purpose so the sync test can read it without pulling in the
// MCP SDK. mcp-version-sync.test.ts fails the build when this and
// mcp/package.json disagree, so bumping the package without bumping this is not
// a thing that can be forgotten.
export const SERVER_NAME = "denpex";
// 0.2.14: the r7 engine changed this package's shipped offline payload
// (src/offline/canonical-engine.mjs and src/data/denpex_patterns.json). 0.2.13 is
// already on npm carrying the r5 payload, so reusing it would make one version
// number mean two different engines, exactly the drift the note above describes.
// 0.2.15: the r8 engine adds source-backed agent-challenge causal contracts and
// calibrated evidence requests. The version must move because npm packages are
// immutable and the executable embeds the canonical offline engine.
// 0.2.16: r9 preserves mechanism-specific verification and follow-up questions
// while refusing invented node identities and unrelated tenant-history claims.
// 0.2.17: the r12 engine changed this package's embedded offline payload
// (src/offline/canonical-engine.mjs). The distribution audit caught the exact
// hazard this file exists for on 2026-08-25: npm still served 0.2.16 while the
// repo built DIFFERENT executable code under that same number, so `npm i
// denpex-mcp@0.2.16` and the repo disagreed about what 0.2.16 means. npm
// packages are immutable, so the number has to move rather than be reused.
// 0.2.18: synchronize the packaged engine with the verified website release,
// including the source-backed Xid 79 correction. Do not reuse published versions.
// 0.2.19: source-backed TensorRT-LLM FP8 architecture and model support correction.
// 0.2.38: aligns the free/no-key MCP server with the Open VSX extension (local-first canonical offline diagnosis, local follow-ups via `ask_followup`, automatic local fallback on anonymous cloud 401/403/429, and the Cloud Deep Reasoning / 30-Day Free Team Trial callout).
// 0.2.41: adds repository metadata and official Denpex ecosystem documentation links.
export const SERVER_VERSION = "0.2.42";
