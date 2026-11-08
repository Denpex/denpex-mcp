# Denpex MCP server

Log files up to 100 MB are read in bounded chunks and reduced to diagnostic evidence before cloud submission. Binary files and invalid UTF-8 are rejected. Keep the original log: evidence selection can omit context.

Diagnose GPU/ML training failures. CUDA OOM, NCCL timeouts, Xid faults, NaN loss,
checkpoint corruption, **without leaving your AI tool**. Ask Claude Desktop, Cursor,
or Claude Code to *"diagnose the crash in `./logs/train.err`"* and Denpex reads the log
straight off disk and hands back the root cause and the fix.

- 🩺 **Root cause + escalating fix** (primary → fallback → emergency), verification command, and prevention.
- 🧭 **Find the culprit rank** in a distributed/NCCL hang, and route GPU Xid faults to the right node action, offline, instantly.
- 📚 **Bundled failure encyclopedia** (500+ documented classes) searchable by error code or symptom.
- 🔒 **Zero-egress mode** (`DENPEX_LOCAL=1`): diagnose entirely on-host, nothing leaves the machine. Plus client-side PII scrubbing even in cloud mode.

---

## Quick start (60 seconds)

### 1. Get an API key (optional but recommended)

Sign in at **[denpex.com/dashboard](https://denpex.com/dashboard) → API Keys** and create a key (`dpx_…`).
The key unlocks authenticated cloud diagnosis, your diagnosis history, quota, and fleet
incidents. *Without a key, `diagnose_crash` and `ask_followup` default to running the
canonical deterministic engine entirely locally (unlimited free local runs). You can escalate
a specific diagnosis to the Denpex cloud without a key by passing `cloud: true`, which uses
the frictionless anonymous engine (requires an API key or browser check if anonymous quota
is exhausted). Set `DENPEX_LOCAL=1` explicitly for permanent zero-egress.*

### 2. Add it to your client

<details open>
<summary><b>Claude Desktop</b></summary>

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "denpex": {
      "command": "npx",
      "args": ["-y", "denpex-mcp"],
      "env": { "DENPEX_API_KEY": "dpx_your_key_here" }
    }
  }
}
```
Restart Claude Desktop.
</details>

<details>
<summary><b>Cursor</b></summary>

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "denpex": {
      "command": "npx",
      "args": ["-y", "denpex-mcp"],
      "env": { "DENPEX_API_KEY": "dpx_your_key_here" }
    }
  }
}
```
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add denpex -e DENPEX_API_KEY=dpx_your_key_here -- npx -y denpex-mcp
```
</details>

### 3. Use it

> "My training job crashed, diagnose the log at `./logs/rank0.err`."
> "What does Xid 79 mean?"
> "This 64-GPU run is hung. Which rank failed first?"  *(→ `analyze_cascade`)*

Or pick the **`diagnose-training-crash`** prompt your client surfaces.

---

## Offline / air-gapped mode

Diagnose entirely on-host, no network, no logs leaving the cluster. Ideal for VPCs,
secure data centers, and privacy-sensitive labs. Add `DENPEX_LOCAL=1`:

```json
{ "mcpServers": { "denpex": {
  "command": "npx", "args": ["-y", "denpex-mcp"],
  "env": { "DENPEX_LOCAL": "1" }
} } }
```

The package bundles the same canonical deterministic diagnosis pipeline used by the hosted
wrapper: 10,700+ patterns, causal detectors and contradiction gates, Xid routing, cross-rank
cascade localization, and the 500+ class encyclopedia. It returns the initiating rank/node
when the evidence identifies one. Only the hosted LLM fallback and live-research enrichment
are unavailable offline.

---

## Tools

| Tool | What it does | Needs |
|------|--------------|-------|
| `diagnose_crash` | Root cause + escalating fix from `logs` / `file` / `dir`. Also accepts `telemetry` (dmesg / nvidia-smi / ibstat), `codeContext`, `topologyMap`, typed `operatorAnswers`, and (after an anonymous MCP restart) the prior `refinementToken`. | local-first by default without a key; cloud with key or `cloud: true` |
| `lookup_failure` | Search the bundled encyclopedia (500+ classes) by code/keyword/symptom. | works offline |
| `analyze_cascade` | Find the culprit rank in a distributed hang; route Xid faults. | works offline |
| `submit_fix_outcome` | Report whether a fix worked. **This is what makes the next diagnosis better.** | API key |
| `check_quota` | Your plan and remaining diagnoses this month. | API key |
| `recent_diagnoses` | Recall your recent diagnoses and their fixes. | API key |
| `ask_followup` | Conversational follow-up on a diagnosis. | local text-extraction without a key; generative chat with Team plan / trial |
| `check_versions` | Flag known-bad CUDA/PyTorch/NCCL/driver combos. | Team plan / trial |
| `compare_runs` | "It worked yesterday", isolate what changed between a good run and a bad one. | Team plan / trial |
| `diff_environments` | Diff torch/CUDA/NCCL/driver versions and env vars between two runs. | Team plan / trial |
| `validate_checkpoint` | Find the newest checkpoint that is actually safe to resume from. | Team plan / trial |
| `preflight_check` | "Is this cluster safe to launch on?", blockers before you burn GPU-hours. | Scale plan |
| `node_health` | Score every monitored node, worst first. | Scale plan |
| `predict_failures` | Nodes trending toward a failure that has not happened yet. | Scale plan |
| `list_incidents` | Incidents Denpex's monitor caught & escalated on your fleet. | Scale plan |

Gated tools degrade gracefully, they tell you exactly which plan unlocks them and which
tools work on your current plan. The failure encyclopedia is also exposed as resources at
`denpex://failures/{slug}`.

**Structured output.** Every tool above returns `structuredContent` alongside its
markdown, validated against a declared output schema, so an agent branches on
`confidenceBand === "low"` or iterates `rankedHypotheses` instead of regexing prose.
Two fields deserve attention when you write the agent loop:

- **`confidence: null`** does not mean zero. It means the engine measured this band's
  historical accuracy and declined to state a number. Treat the verdict as a lead. Do
  not substitute the raw score.
- **`unfalsified: true`** identifies only the explicitly enabled reduced compatibility
  fallback, where the canonical contradiction graph did not run. Normal cloud and
  `DENPEX_LOCAL=1` diagnosis both use the canonical engine and set it to false.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DENPEX_API_KEY` |, | Your `dpx_…` key. Enables cloud tools. |
| `DENPEX_API_URL` | `https://api.denpex.com` | Override the API base (self-host / staging). |
| `DENPEX_LOCAL` | `0` | `1` → diagnose entirely on-host (zero egress). |
| `DENPEX_PRIVACY` | `off` | `mask` / `strict` → scrub PII from logs **before** they leave the machine. |

---

## Develop

```bash
npm install
npm run build      # regenerates the canonical engine + corpus, then bundles dist/index.js
npm test           # 111 unit + protocol-integration tests
npm run inspector  # interactive protocol inspector (MCP Inspector)
```

The offline corpus (`src/data/denpex_patterns.json`) and canonical engine
(`src/offline/canonical-engine.mjs`) are generated from the repo's single source of truth
during `npm run build`, never hand-edit either artifact.

---

## Official Denpex Ecosystem & Documentation

| Resource | Description | Link |
| :--- | :--- | :--- |
| **Denpex Platform** | Deterministic GPU and ML training failure diagnostics | [denpex.com](https://denpex.com) |
| **Documentation Hub** | Quickstart guides, architecture, and operational reference | [denpex.com/docs](https://denpex.com/docs) |
| **Python Agent & CLI** | On-host monitoring, evidence capture, and zero-egress CLI | [denpex.com/docs/agent](https://denpex.com/docs/agent) |
| **REST API Reference** | Programmatic `/api/diagnose` and preflight endpoints | [denpex.com/docs/api](https://denpex.com/docs/api) |
| **VS Code Extension** | Offline GPU crash diagnostics in VS Code | [denpex.com/vscode](https://denpex.com/vscode) |
| **Open VSX Extension** | Extension for Cursor, Windsurf, VSCodium, and Gitpod | [denpex.com/openvsx](https://denpex.com/openvsx) |
| **Failure Encyclopedia** | 500+ documented CUDA, NCCL, Xid, Slurm, and vLLM failures | [denpex.com/failures](https://denpex.com/failures) |
| **Free GPU Tools** | VRAM, NCCL, DeepSpeed ZeRO, and Slurm calculators | [denpex.com/tools](https://denpex.com/tools) |
| **NVIDIA Xid Reference** | Hardware vs software Xid fault routing table | [denpex.com/xid](https://denpex.com/xid) |
| **Release Changelog** | Platform, agent, SDK, and extension release notes | [denpex.com/changelog](https://denpex.com/changelog) |

