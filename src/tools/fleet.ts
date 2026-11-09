// WO-3.7, thin wrappers over routes that already exist and were unreachable from an
// agent. Grouped here because they share one shape: authenticate, call, render.
//
// The ordering follows the work order: `submit_fix_outcome` (tools/feedback.ts) first
// because it is the learning loop's only agent-side input, then preflight ("is this
// cluster safe to launch 512 GPUs on?"), then the two "it worked yesterday" tools -
// which together are the second-most-common question after "why did it crash", then
// checkpoint validation, then the fleet reads.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";
import { requireCloud } from "../config.js";
import { resolveLogs, assertEnoughLog, condenseLogs } from "../logs.js";
import { applyPrivacy } from "../privacy.js";
import { describeError } from "../errors.js";
import { toolText, toolResult } from "./util.js";

type Dict = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const arr = (v: unknown): Dict[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Dict[]) : []);

function bullets(title: string, items: string[]): string[] {
  return items.length ? ["", `**${title}**`, ...items.map((i) => `- ${i}`)] : [];
}

export function registerFleetTools(server: McpServer, ctx: ToolContext): void {
  // ── launch_gate ────────────────────────────────────────────────────────────
  //
  // Distinct from `preflight_check` below, and the difference matters enough to
  // be two tools rather than one with a mode flag. `preflight_check` reads
  // artifacts a human pasted and asks "does this cluster look healthy". This
  // asks a sharper question: given THESE exact nodes and GPU indices, does
  // Denpex's own fleet record contain a reason not to place the job here.
  //
  // It is read-only and advisory unless `enforce` is set, so an agent calling it
  // on every submission cannot stop a queue.
  server.registerTool(
    "launch_gate",
    {
      title: "Gate a job before it lands on a bad GPU",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Evaluate the EXACT allocation a scheduler is about to hand out, these nodes, these GPU indices, against what Denpex knows about them: quarantined or repeat-offender cards, split driver versions inside one collective, software combinations that have crashed and never completed, degraded fabric links, an incomplete distributed checkpoint, storage about to hit ENOSPC. Returns GO / GO_WITH_WARNING / REQUIRE_APPROVAL / BLOCK with the evidence for each. Advisory unless `enforce` is true. IMPORTANT: a check Denpex could not evaluate is reported as unknown, never as a pass, read `evidenceCoverage` before treating a GO as an all-clear.",
      inputSchema: {
        gpus: z
          .array(z.object({ node: z.string(), gpuIndex: z.number().int().min(0) }))
          .min(1)
          .describe("Every GPU the scheduler proposes to allocate."),
        jobName: z.string().optional(),
        stack: z
          .object({
            driver: z.string().optional(), cuda: z.string().optional(), nccl: z.string().optional(),
            ofed: z.string().optional(), firmware: z.string().optional(),
            fabricManager: z.string().optional(), framework: z.string().optional(),
            containerDigest: z.string().optional(),
          })
          .optional()
          .describe("Software the job will run with. Omitting it makes the known-bad-cohort check report unknown."),
        checkpoint: z
          .object({
            path: z.string().optional(), exists: z.boolean().optional(), readable: z.boolean().optional(),
            shardsFound: z.number().optional(), shardsExpected: z.number().optional(),
          })
          .optional(),
        storage: z
          .object({
            path: z.string().optional(), freeBytes: z.number().optional(),
            totalBytes: z.number().optional(), freeInodes: z.number().optional(),
          })
          .optional(),
        enforce: z.boolean().optional().describe("Apply the verdict. Default false, advisory only."),
      },
      outputSchema: {
        verdict: z.string().describe("GO | GO_WITH_WARNING | REQUIRE_APPROVAL | BLOCK"),
        advisoryVerdict: z.string().describe("What enforcement WOULD have returned."),
        enforced: z.boolean(),
        evidenceCoverage: z.number().describe("Fraction of proposed GPUs Denpex has a record for, 0..1."),
        checks: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async ({ gpus, jobName, stack, checkpoint, storage, enforce }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const r = await ctx.client.request<Dict>("/api/preflight", {
          method: "POST",
          body: { gpus, jobName: jobName ?? "job", stack, checkpoint, storage, enforce: enforce === true },
        });
        const checks = arr(r.checks);
        const coverage = typeof r.evidenceCoverage === "number" ? r.evidenceCoverage : 0;
        const lines = [
          `## ${String(r.verdict ?? "UNKNOWN")}${r.enforced ? "" : " (advisory)"}, ${str(r.headline) ?? ""}`,
        ];
        // Coverage is surfaced before the checks, not buried under them. A GO on
        // 40% coverage is not an all-clear and must not read like one.
        if (coverage < 1) {
          lines.push("", `_Evidence coverage: ${Math.round(coverage * 100)}% of the proposed GPUs are known to Denpex. The rest were NOT checked._`);
        }
        for (const c of checks) {
          const status = String(c.status ?? "unknown").toUpperCase();
          lines.push("", `### ${status}, ${str(c.title) ?? str(c.id) ?? "check"}`);
          if (str(c.finding)) lines.push(str(c.finding)!);
          const ev = Array.isArray(c.evidence) ? (c.evidence as string[]) : [];
          if (ev.length) lines.push(...ev.slice(0, 4).map((e) => `- ${e}`));
          if (str(c.action) && c.status !== "pass") lines.push(`**Next:** ${str(c.action)}`);
        }
        if (str(r.summary)) lines.push("", str(r.summary)!);
        if (r.advisoryVerdict === "BLOCK" || r.advisoryVerdict === "REQUIRE_APPROVAL") {
          if (str(r.overrideProcedure)) lines.push("", str(r.overrideProcedure)!);
        }
        return toolResult(lines.join("\n"), {
          verdict: String(r.verdict ?? "UNKNOWN"),
          advisoryVerdict: String(r.advisoryVerdict ?? r.verdict ?? "UNKNOWN"),
          enforced: r.enforced === true,
          evidenceCoverage: coverage,
          checks,
        });
      } catch (e) {
        return toolText(describeError(e), true);
      }
    },
  );

  // ── preflight_check ────────────────────────────────────────────────────────
  server.registerTool(
    "preflight_check",
    {
      title: "Preflight a cluster before a large job",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Answer 'is this cluster safe to launch on?' BEFORE you burn GPU-hours on a job that will die in the first ten minutes. Feed it the health artifacts from the nodes you are about to use, `nvidia-smi -q`, `ibstat`, `nvidia-smi topo -m`, `dmesg -T`, and it returns the critical blockers (dead links, missing GPUs, non-NVLink topology, driver mismatch) that would take the run down. Scale+ feature.",
      inputSchema: {
        logs: z.string().optional().describe("Paste the health artifacts (nvidia-smi -q, ibstat, nvidia-smi topo -m, dmesg -T)."),
        file: z.string().optional().describe("Path to a file containing them."),
        dir: z.string().optional().describe("Directory to scan for the newest artifact file."),
      },
      outputSchema: {
        passed: z.boolean().describe("FALSE when any check is critical, do not launch."),
        checkCount: z.number(),
        checks: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async ({ logs, file, dir }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const resolved = await resolveLogs({ logs, file, dir });
        assertEnoughLog(resolved.text);
        const prepared = applyPrivacy(condenseLogs(resolved.text), ctx.config.privacy);
        const r = await ctx.client.request<Dict>("/api/diagnose/preflight", { method: "POST", body: { logs: prepared } });
        const checks = arr(r.checks);
        const passed = r.passed === true;
        const lines = [
          passed
            ? `## Preflight PASSED, no critical blockers in ${checks.length} check(s).`
            : `## Preflight FAILED, do not launch. ${checks.filter((c) => c.severity === "critical").length} critical finding(s).`,
        ];
        for (const c of checks) {
          lines.push("", `### ${String(c.severity ?? "info").toUpperCase()}, ${str(c.title) ?? str(c.id) ?? "check"}`);
          if (str(c.summary)) lines.push(str(c.summary)!);
          if (str(c.action)) lines.push(`**Fix:** ${str(c.action)}`);
          const ev = Array.isArray(c.evidence) ? (c.evidence as string[]) : [];
          if (ev.length) lines.push(`_${ev.slice(0, 3).join(" · ")}_`);
        }
        return toolResult(lines.join("\n"), { passed, checkCount: checks.length, checks });
      } catch (e) {
        return toolText(`Preflight failed: ${describeError(e, { tier: "Scale", tool: "preflight_check" })}`, true);
      }
    },
  );

  // ── compare_runs ───────────────────────────────────────────────────────────
  server.registerTool(
    "compare_runs",
    {
      title: "Compare a working run against a failing one",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "'It worked yesterday.' Give it the logs from the run that worked and the run that failed, and it isolates what actually changed between them instead of re-diagnosing the failure from scratch. Use this whenever a previously-green job starts failing.",
      inputSchema: {
        successLogs: z.string().describe("Logs from the run that worked."),
        failLogs: z.string().describe("Logs from the run that failed."),
      },
      outputSchema: {
        summary: z.string(),
        diffCount: z.number(),
        diffs: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async ({ successLogs, failLogs }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const p = (s: string) => applyPrivacy(condenseLogs(s), ctx.config.privacy);
        const r = await ctx.client.request<Dict>("/api/diagnose/compare", {
          method: "POST",
          body: { successLogs: p(successLogs), failLogs: p(failLogs) },
        });
        const diffs = arr(r.diffs);
        const summary = str(r.summary) ?? `${diffs.length} difference(s) found.`;
        const lines = [`## Run comparison`, "", summary];
        for (const d of diffs.slice(0, 40)) {
          lines.push(`- **${str(d.field) ?? str(d.key) ?? "difference"}**: ${str(d.before) ?? "?"} → ${str(d.after) ?? "?"}${str(d.note) ? `, ${str(d.note)}` : ""}`);
        }
        return toolResult(lines.join("\n"), { summary, diffCount: diffs.length, diffs });
      } catch (e) {
        return toolText(`Comparison failed: ${describeError(e, { tier: "Team", tool: "compare_runs" })}`, true);
      }
    },
  );

  // ── diff_environments ──────────────────────────────────────────────────────
  server.registerTool(
    "diff_environments",
    {
      title: "Diff the package/driver environment of two runs",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Diff the SOFTWARE environment between a good run and a bad one, torch / CUDA / NCCL / driver / flash-attn versions, env vars, and flag combinations known to be broken. Feed it `pip freeze`, `nvidia-smi`, `env` output (or the whole job log; it extracts what it needs). Use this when `compare_runs` points at a version change, or when a job breaks after an image rebuild.",
      inputSchema: {
        goodRun: z.string().describe("Artifacts from the last good run (pip freeze / nvidia-smi / env, or the full log)."),
        badRun: z.string().describe("The same artifacts from the failing run."),
        failureLogs: z.string().optional().describe("Optional: the failure output itself, for fingerprinting."),
      },
      outputSchema: {
        summary: z.string(),
        changeCount: z.number(),
        changes: z.array(z.record(z.string(), z.unknown())),
        verdict: z.record(z.string(), z.unknown()).nullable(),
      },
    },
    async ({ goodRun, badRun, failureLogs }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const p = (s: string) => applyPrivacy(condenseLogs(s), ctx.config.privacy);
        const r = await ctx.client.request<Dict>("/api/diagnose/env-diff", {
          method: "POST",
          body: { goodRun: p(goodRun), badRun: p(badRun), ...(failureLogs ? { failureLogs: p(failureLogs) } : {}) },
        });
        const changes = arr(r.changes ?? r.diffs ?? r.deltas);
        const summary = str(r.summary) ?? `${changes.length} environment change(s).`;
        const lines = [`## Environment diff`, "", summary];
        for (const c of changes.slice(0, 60)) {
          lines.push(`- **${str(c.name) ?? str(c.package) ?? str(c.field) ?? "change"}**: ${str(c.good) ?? str(c.before) ?? "?"} → ${str(c.bad) ?? str(c.after) ?? "?"}${str(c.note) ? `, ${str(c.note)}` : ""}`);
        }
        if (str(r.recommendation)) lines.push("", `**Recommendation:** ${str(r.recommendation)}`);
        return toolResult(lines.join("\n"), {
          summary,
          changeCount: changes.length,
          changes,
          verdict: (r.verdict as Dict | undefined) ?? null,
        });
      } catch (e) {
        return toolText(`Environment diff failed: ${describeError(e, { tier: "Team", tool: "diff_environments" })}`, true);
      }
    },
  );

  // ── validate_checkpoint ────────────────────────────────────────────────────
  server.registerTool(
    "validate_checkpoint",
    {
      title: "Inspect supplied checkpoint integrity evidence",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Inspect directory listings, checksum output and load errors for signs of checkpoint corruption. Supplied metadata does not verify full shard coverage, compatible optimizer state or successful workload recovery. Validate actual loading and intended progress before resuming.",
      inputSchema: {
        directoryListing: z.string().optional().describe("Output of `ls -la` (or `ls -la --time-style=full-iso`) on the checkpoint directory."),
        sha256Output: z.string().optional().describe("Output of `sha256sum -c MANIFEST.sha256`, if you keep a manifest."),
        loadErrors: z.string().optional().describe("Any error output from trying to load a checkpoint."),
        failureType: z.string().optional().describe("The diagnosed failure type, if you have one, it sharpens the verdict."),
      },
      outputSchema: {
        candidateArtifact: z.string().nullable(),
        resumeVerified: z.literal(false),
        workloadRecoveryVerified: z.literal(false),
        latestValidCheckpoint: z.string().nullable(),
        validCheckpoints: z.array(z.string()),
        corruptedCheckpoints: z.array(z.string()),
        issues: z.array(z.string()),
        recommendation: z.string(),
      },
    },
    async ({ directoryListing, sha256Output, loadErrors, failureType }) => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      if (!directoryListing && !sha256Output && !loadErrors) {
        return toolText("Give me at least one of `directoryListing` (ls -la of the checkpoint dir), `sha256Output`, or `loadErrors`.", true);
      }
      try {
        const p = (s?: string) => (s ? applyPrivacy(s, ctx.config.privacy) : undefined);
        const r = await ctx.client.request<Dict>("/api/checkpoint/validate", {
          method: "POST",
          body: { directoryListing: p(directoryListing), sha256Output: p(sha256Output), loadErrors: p(loadErrors), failureType },
        });
        const valid = (Array.isArray(r.validCheckpoints) ? r.validCheckpoints : []) as string[];
        const corrupt = (Array.isArray(r.corruptedCheckpoints) ? r.corruptedCheckpoints : []) as string[];
        const issues = (Array.isArray(r.issues) ? r.issues : []) as string[];
        const latest = str(r.latestValidCheckpoint);
        const recommendation = str(r.recommendation) ?? "";
        const lines = [
          '## Checkpoint evidence assessment', ...bullets("Corruption signals", corrupt), ...bullets("Checksum-passing entries supplied", valid.slice(0, 10)), ...bullets("Issues", issues),
          'Resume is not verified. Check the complete manifest, actual load, configuration compatibility and workload progress.',
        ];
        if (recommendation) lines.push("", `**Recommendation:** ${recommendation}`);
        return toolResult(lines.join("\n"), {
          candidateArtifact: str(r.candidateArtifact),
          resumeVerified:false,
          workloadRecoveryVerified:false,
          latestValidCheckpoint: latest,
          validCheckpoints: valid,
          corruptedCheckpoints: corrupt,
          issues,
          recommendation,
        });
      } catch (e) {
        return toolText(`Checkpoint validation failed: ${describeError(e, { tier: "Team", tool: "validate_checkpoint" })}`, true);
      }
    },
  );

  // ── node_health ────────────────────────────────────────────────────────────
  server.registerTool(
    "node_health",
    {
      title: "Score every monitored node's health",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Score the health of every node Denpex is monitoring in your fleet, worst first. Use it to answer 'which nodes should I exclude from this job?' before scheduling, or 'what else is degrading?' after an incident. Scale+ feature; requires the Denpex agent to be reporting.",
      inputSchema: {},
      outputSchema: {
        nodeCount: z.number(),
        nodes: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async () => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const r = await ctx.client.request<Dict>("/api/fleet/node-health");
        const nodes = arr(r.nodes ?? r.hosts ?? r.results);
        if (!nodes.length) return toolResult("No nodes are reporting yet. Install the Denpex agent on the nodes you want monitored.", { nodeCount: 0, nodes: [] });

        // ── LAUNCH AUDIT: this formatter read fields the API does not return ──────
        // It looked for `riskScore`, `level`, `riskLevel` and `summary`. GET
        // /api/fleet/node-health returns NodeHealth objects with `host`, `score`,
        // `band`, `action`, `signals`, `trend`, `etaHeartbeats`, `stale` and
        // `predictive` (see worker/node-health.ts). Only `host` and `score` lined up,
        // so every node rendered as bare "host, 42" with no severity band and no
        // reason. The whole point of this tool is to answer "which nodes do I exclude
        // from this job?", and the band and the recommended action, the two fields
        // that answer it, were the ones being dropped.
        //
        // Worst-first, because the caller reads the top of the list and stops.
        const BAND_ORDER: Record<string, number> = { critical: 0, degrading: 1, watch: 2, unknown: 3, healthy: 4 };
        const rank = (n: Dict) => {
          const band = str(n.band);
          const b = (band ? BAND_ORDER[band] : undefined) ?? 3;
          const s = typeof n.score === "number" ? n.score : 100;
          return b * 1000 + s;
        };
        const sorted = [...nodes].sort((a, b) => rank(a as Dict) - rank(b as Dict));

        const summary = (r.summary ?? {}) as Dict;
        const lines = [`## Node health, ${nodes.length} node(s)`, ""];
        if (typeof summary.nodes === "number") {
          const counts = (["critical", "degrading", "watch", "healthy", "unknown"] as const)
            .filter((k) => typeof summary[k] === "number" && (summary[k] as number) > 0)
            .map((k) => `${summary[k]} ${k}`);
          if (counts.length) lines.push(`${counts.join(" · ")}`, "");
        }

        for (const raw of sorted.slice(0, 60)) {
          const n = raw as Dict;
          const host = str(n.host) ?? str(n.node) ?? "node";
          const score = typeof n.score === "number" ? n.score : null;
          const band = str(n.band);
          const action = str(n.action);
          const trend = str(n.trend);

          // The single sharpest line about a node is its worst signal's detail -
          // "row-remap pending on GPU 3", not the score. Signals are already ordered
          // by weight server-side.
          const signals = arr(n.signals);
          const worst = signals.length ? (signals[0] as Dict) : null;
          const detail = worst ? str(worst.detail) : null;

          const bits: string[] = [];
          if (score !== null) bits.push(`${score}/100`);
          if (band) bits.push(band);
          if (action && action !== "none") bits.push(`action: ${action}`);
          if (trend && trend !== "stable") bits.push(trend);
          if (n.stale === true) bits.push("STALE, not reporting");

          lines.push(`- **${host}**${bits.length ? `, ${bits.join(" · ")}` : ""}`);
          if (detail) lines.push(`  - ${detail}`);

          // Model-backed failure probability, when the node's operating hours are known.
          const pred = (n.predictive ?? {}) as Dict;
          if (typeof pred.probability === "number") {
            const pct = Math.round(pred.probability * 1000) / 10;
            const horizon = typeof pred.horizonHours === "number" ? ` over ${pred.horizonHours}h` : "";
            lines.push(`  - ${pct}% modelled failure probability${horizon}`);
          }
          if (typeof n.etaHeartbeats === "number" && n.etaHeartbeats > 0) {
            lines.push(`  - crosses threshold in ~${n.etaHeartbeats} heartbeat(s)${str(n.etaBasis) ? ` (${str(n.etaBasis)})` : ""}`);
          }
        }

        if (sorted.length > 60) lines.push("", `_Showing the 60 worst of ${sorted.length} nodes._`);
        if (r.truncated === true) lines.push("", "_The server returned a bounded subset of your fleet; totals above are fleet-wide._");

        const model = (r.model ?? {}) as Dict;
        if (model.fitted === false) {
          lines.push("", `_Failure probabilities use the documented prior, not a fit to your fleet (${model.failures ?? 0} observed failures). Treat them as a starting point._`);
        }

        return toolResult(lines.join("\n"), { nodeCount: nodes.length, nodes });
      } catch (e) {
        return toolText(`Could not fetch node health: ${describeError(e, { tier: "Scale", tool: "node_health" })}`, true);
      }
    },
  );

  // ── predict_failures ───────────────────────────────────────────────────────
  server.registerTool(
    "predict_failures",
    {
      title: "List nodes trending toward failure",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "List the predictive risk scores Denpex has computed for your fleet, nodes whose counters are trending toward a failure that has not happened yet (rising correctable ECC, row-remap pressure, PCIe replays, thermal drift). Use it to drain a node on your schedule instead of the cluster's. Scale+ feature.",
      inputSchema: {},
      outputSchema: {
        scoreCount: z.number(),
        scores: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async () => {
      const blocked = requireCloud(ctx.config);
      if (blocked) return toolText(blocked, true);
      try {
        const r = await ctx.client.request<Dict>("/api/predictive/scores");
        const scores = arr(r.scores);
        if (!scores.length) return toolResult("No predictive scores yet, they accumulate as the agent reports telemetry.", { scoreCount: 0, scores: [] });
        const lines = [`## Predictive risk, ${scores.length} score(s)`, ""];
        for (const s of scores) {
          lines.push(
            `- **${str(s.predicted_failure_type) ?? "risk"}**, ${s.risk_score ?? "?"}/100 (${str(s.risk_level) ?? "?"})${str(s.trend) ? `, trend ${str(s.trend)}` : ""}${str(s.diagnosis_id) ? ` · diagnosisId ${str(s.diagnosis_id)}` : ""}`,
          );
        }
        return toolResult(lines.join("\n"), { scoreCount: scores.length, scores });
      } catch (e) {
        return toolText(`Could not fetch predictive scores: ${describeError(e, { tier: "Scale", tool: "predict_failures" })}`, true);
      }
    },
  );
}
