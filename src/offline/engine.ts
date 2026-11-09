// Reduced offline helper retained for encyclopedia lookup, cascade analysis, and
// explicit compatibility tests. `diagnose_crash` now runs the generated canonical
// worker bundle in canonical-engine.mjs, not this smaller implementation.
//
// Four layers, in order: (1) cross-rank cascade localization + Xid→node-action
// routing (deterministic detectors), (2) portable grouped causal contracts,
// (3) the fast regex pattern tier, and (4) the generated evidence-gated
// encyclopedia matched by IDF-weighted cosine similarity + error-signature
// anchoring.
//
// ── HISTORICAL COMPATIBILITY BOUNDARY ───────────────────────────────────────
// Before the canonical bundle, this was the MCP diagnosis path and its parity
// gaps were customer-visible. Keep the differences documented because tests and
// the non-diagnosis helpers still exercise it:
//
//   1. CORPUS. The generated regex records and encyclopedia classes are
//      synchronized, including pattern-level evidence gates. The canonical worker additionally
//      has type/family contracts, keyword, community and research-grounding tiers.
//   2. TIER ORDER. This engine resolves deterministic detectors → portable causal
//      contracts → patterns → encyclopedia. The cloud additionally has the flight
//      recorder and several worker-only arbitration tiers, so an uncovered collision
//      can still produce a different answer.
//   3. PARTIAL FALSIFICATION. Grouped positive evidence and exclusions ship for the
//      portable causal contracts, and pattern-level required/negative evidence ships
//      for the registry. Cloud-only type/family contracts and telemetry contradictions
//      still do not. Only causal-contract verdicts clear `unfalsified`; other offline
//      tiers retain the caveat in format.ts.
//
// The canonical zero-egress diagnosis path has none of these deterministic gaps;
// only hosted LLM and live-research enrichment are unavailable there.
import rawDb from "../data/denpex_patterns.json";

interface PatternEntry {
  type: string;
  re: string;
  flags?: string;
  confidence: number;
  summary: string;
  action: string;
  resumeFrom?: string | null;
  requiredEvidence?: RegexSpec[];
  requiredEvidenceMode?: "all" | "any";
  negativeEvidence?: RegexSpec[];
}
interface RegexSpec {
  re: string;
  flags?: string;
}
interface CausalContractEntry {
  id: string;
  failureType: string;
  title: string;
  required: RegexSpec[][];
  excluded?: RegexSpec[];
  confidence: number;
  severity?: "info" | "warning" | "critical";
  summary: string;
  action: string;
  fallbackAction?: string | null;
  resumeFrom?: string | null;
  isHealthy?: boolean;
  origin?: string;
}
interface EncyclopediaEntry {
  slug: string;
  title: string;
  category: string;
  text: string;
  anchorText: string;
  action: string;
  steps: string[];
}
interface PatternsDB {
  version: number;
  generated: string;
  patterns: PatternEntry[];
  causalContracts?: CausalContractEntry[];
  encyclopedia: EncyclopediaEntry[];
}

export interface Detector {
  id: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  action: string;
}
export interface LocalDiagnosis {
  failureType: string;
  confidence: number;
  summary: string;
  action: string;
  fallbackAction?: string | null;
  resumeFrom?: string | null;
  steps?: string[];
  evidence?: string[];
  severity?: "info" | "warning" | "critical";
  isHealthy?: boolean;
  causalContract?: string;
  competingOwners?: string[];
  source: "local-causal-contract" | "local-pattern" | "local-encyclopedia" | "local-detector" | "local";
  detectors: Detector[];
}
export interface EncyclopediaHit {
  slug: string;
  title: string;
  category: string;
  confidence: number;
  action: string;
  steps: string[];
  evidence: string[];
}

const DB = rawDb as unknown as PatternsDB;

// ── Xid → node action (mirrors worker/detectors.ts XID_TABLE) ────────────────
const XID_TABLE: Record<number, [string, string, Detector["severity"]]> = {
  13: ["Graphics Engine Exception (app/user error)", "NONE", "info"],
  31: ["GPU memory page fault (app/driver)", "NONE", "warning"],
  43: ["GPU stopped processing (app error)", "NONE", "warning"],
  45: ["Preemptive cleanup (channel teardown)", "NONE", "info"],
  48: ["Double-Bit ECC error (DBE)", "RESET", "critical"],
  61: ["Internal micro-controller breakpoint", "REBOOT", "warning"],
  62: ["Internal micro-controller halt", "REBOOT", "warning"],
  63: ["ECC page retirement / row remap recorded", "RESET", "warning"],
  64: ["ECC row-remap FAILURE", "RMA", "critical"],
  74: ["NVLink error (peer may be the initiator)", "PEER_CHECK", "critical"],
  79: ["GPU has fallen off the bus", "REBOOT", "critical"],
  92: ["High single-bit ECC rate", "ISOLATE", "warning"],
  94: ["Contained ECC error", "APP_RESTART", "critical"],
  95: ["Uncontained ECC error", "RESET", "critical"],
  119: ["GSP RPC timeout", "REBOOT", "critical"],
  120: ["GSP error", "REBOOT", "critical"],
  122: ["SPI PMU RPC read failure", "RMA", "critical"],
  123: ["SPI PMU RPC write failure / secure-boot fault", "RMA", "critical"],
  // Extended coverage, these 9 codes existed in worker/detectors.ts and
  // agent/denpex_local.py but were MISSING here, so an offline MCP user (DENPEX_LOCAL=1
  // or no key) got no Xid routing for e.g. 140 (uncontained ECC), 80 (corrupted PCIe
  // data), or 109 (context-switch timeout preceding a GSP hang). Synced.
  32: ["Invalid/corrupted push buffer stream (PCIe/DMA path)", "RESET", "warning"],
  38: ["Driver firmware error", "RESET", "warning"],
  68: ["NVDEC/video engine exception (app/driver)", "NONE", "info"],
  69: ["Graphics engine class error", "RESET", "warning"],
  80: ["Corrupted data sent to GPU (PCIe / system-memory path)", "REBOOT", "critical"],
  109: ["Context-switch timeout (often precedes GSP 119)", "RESET", "critical"],
  121: ["C2C link corrected error (Grace-Hopper), watch the trend", "ISOLATE", "warning"],
  140: ["ECC unrecovered error (uncontained state)", "RESET", "critical"],
  154: ["GPU recovery action event, the driver message names the required recovery; follow it", "ISOLATE", "critical"],
};
const ACTION_RANK: Record<string, number> = { NONE: 0, APP_RESTART: 1, ISOLATE: 2, PEER_CHECK: 3, RESET: 4, REBOOT: 5, RMA: 6 };
const ACTION_DETAIL: Record<string, string> = {
  RMA: "Hardware fault, open an RMA and remove from the pool.",
  RESET: "After the affected job exits, reset the GPU and validate it; quarantine/escalate only if the fault recurs or diagnostics fail.",
  REBOOT: "Capture PCIe AER/IOMMU and driver evidence, then perform a full node reboot; RMA/service the GPU or PCIe path only on recurrence or failed diagnostics.",
  APP_RESTART: "Terminate and restart/requeue only the affected application. Other applications are not automatically corrupted; reset the GPU at a safe maintenance point and escalate only on recurrence or failed diagnostics.",
  PEER_CHECK: "Inspect both NVLink endpoints and the NVSwitch/Fabric Manager event order before reset or replacement; Xid 74 can be sympathetic to a peer failure.",
  ISOLATE: "Cordon the node and watch the single-bit ECC trend.",
  NONE: "Application/user-level fault, no node action.",
};

const PRIMARY_FAULT =
  /CUDA error|device-side assert|illegal memory access|segmentation fault|core dumped|\bXid\b|out of memory|uncorrectable ECC|NVLink error/i;
const COLLATERAL =
  /Watchdog caught collective|collective operation timeout|NCCL.*\btimeout\b|timed out waiting|Connection (?:closed|reset) by peer/i;

const STOP = new Set(
  "the and for with this that are was were has have will your you not from out can but its use using due when which while into per via also may any all one two get set run job see how why what where some then than they their them our about after before been being does did each more most other such only over same these those both few here there".split(
    " ",
  ),
);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []).filter((t) => !STOP.has(t));
}

// ── Error-signature anchors (compact; mirrors denpex_local.py _ANCHORS) ──────
const ANCHORS: Array<{ re: RegExp; label: (m: RegExpExecArray) => string }> = [
  { re: /\bxid[:\s]*?(\d{1,3})\b/gi, label: (m) => `xid-${m[1]}` },
  { re: /\bcuda (?:error|failure)[:\s]*?(\d{1,4})\b/gi, label: (m) => `cuda-err-${m[1]}` },
  { re: /out of memory|outofmemoryerror|\boom\b/gi, label: () => "oom" },
  { re: /fallen off the bus|off the bus/gi, label: () => "gpu-off-bus" },
  { re: /device-side assert|same device, but found|tensors to be on the same device|illegal memory access/gi, label: () => "device-assert" },
  { re: /watchdog[^\n]{0,30}timeout|collective[^\n]{0,20}timeout|nccl[^\n]{0,12}timeout/gi, label: () => "nccl-timeout" },
  { re: /torch\._?dynamo|torch\.compile|\bdynamo\b/gi, label: () => "torch-compile" },
  { re: /\bdeepspeed\b|zero[\s-]?(?:stage[\s-]?)?3/gi, label: () => "deepspeed" },
  { re: /\bfsdp\b|fully[\s_]?sharded/gi, label: () => "fsdp" },
  { re: /unpicklingerror|pytorchstreamreader|checkpoint[^\n]{0,20}corrupt|error\(s\) in loading state_dict|load_state_dict/gi, label: () => "checkpoint" },
  { re: /loss[^\n]{0,8}nan|nan[^\n]{0,8}loss/gi, label: () => "nan-loss" },
  { re: /nvlink|nvls|nvswitch/gi, label: () => "nvlink" },
  { re: /segmentation fault|core dumped|sigsegv/gi, label: () => "segfault" },
  { re: /straggler|slow rank/gi, label: () => "straggler" },
];

function anchorsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const rule of ANCHORS) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      out.add(rule.label(m));
      if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width
    }
  }
  return out;
}

// ── Built-once index ─────────────────────────────────────────────────────────
interface IndexedEntry {
  e: EncyclopediaEntry;
  weights: Map<string, number>;
  norm: number;
  anchors: Set<string>;
}
interface Engine {
  patterns: Array<{ re: RegExp; required: RegExp[]; negative: RegExp[]; p: PatternEntry }>;
  causalContracts: Array<{ required: RegExp[][]; excluded: RegExp[]; contract: CausalContractEntry }>;
  index: IndexedEntry[];
  idf: (t: string) => number;
  count: number;
}

let ENGINE: Engine | null = null;

function buildEngine(): Engine {
  if (ENGINE) return ENGINE;

  const compile = (spec: RegexSpec): RegExp => {
    const flags = (spec.flags ?? "").replace(/[^ims]/g, "") || "i";
    return new RegExp(spec.re, flags.includes("i") ? flags : flags + "i");
  };
  const patterns: Array<{ re: RegExp; required: RegExp[]; negative: RegExp[]; p: PatternEntry }> = [];
  for (const p of DB.patterns) {
    try {
      patterns.push({
        re: compile(p),
        required: (p.requiredEvidence ?? []).map(compile),
        negative: (p.negativeEvidence ?? []).map(compile),
        p,
      });
    } catch {
      /* skip an un-compilable pattern rather than crash */
    }
  }

  const causalContracts: Engine["causalContracts"] = [];
  for (const contract of DB.causalContracts ?? []) {
    try {
      causalContracts.push({
        required: contract.required.map((group) => group.map(compile)),
        excluded: (contract.excluded ?? []).map(compile),
        contract,
      });
    } catch {
      /* one malformed portable contract must not make offline diagnosis unavailable */
    }
  }

  const enc = DB.encyclopedia;
  const df = new Map<string, number>();
  const docs = enc.map((e) => {
    const toks = new Set(tokenize(e.text));
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
    return { e, toks, anchors: anchorsOf(e.anchorText) };
  });
  const n = enc.length || 1;
  const idf = (t: string): number => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const index: IndexedEntry[] = docs.map(({ e, toks, anchors }) => {
    const weights = new Map<string, number>();
    let sq = 0;
    for (const t of toks) {
      const w = idf(t);
      weights.set(t, w);
      sq += w * w;
    }
    return { e, weights, norm: Math.sqrt(sq) || 1, anchors };
  });

  ENGINE = { patterns, causalContracts, index, idf, count: enc.length };
  return ENGINE;
}

// ── Detectors ────────────────────────────────────────────────────────────────
function xidSeen(logs: string): Map<number, string> {
  const seen = new Map<number, string>();
  for (const line of logs.split("\n")) {
    if (!/xid/i.test(line)) continue;
    const m = line.match(/Xid\s*\([^)]*\)\s*:?\s*(\d{1,3})\b/i) || line.match(/Xid\b\s*:?\s*(\d{1,3})\b/i);
    if (m) {
      const code = parseInt(m[1]!, 10);
      if (!seen.has(code)) seen.set(code, line.trim().slice(0, 200));
    }
  }
  return seen;
}

export function routeXid(logs: string): Detector | null {
  const all = xidSeen(logs);
  const seen = [...all.keys()].filter((c) => c in XID_TABLE);
  if (seen.length === 0) return null;
  const worst = seen.reduce((a, b) => (ACTION_RANK[XID_TABLE[b]![1]]! > ACTION_RANK[XID_TABLE[a]![1]]! ? b : a));
  const [name, action, sev] = XID_TABLE[worst]!;
  const routing = seen.slice(0, 6).map((c) => `Xid ${c}, ${XID_TABLE[c]![0]} → ${XID_TABLE[c]![1]}`).join(" | ");
  const detail = ACTION_DETAIL[action]!;
  return {
    id: "xid_router",
    severity: sev,
    summary: `${seen.length} distinct Xid code(s). Highest action: ${action} (Xid ${worst}, ${name}).`,
    action: action !== "NONE" ? `${detail}\nRouting: ${routing}` : `${detail} ${routing}`,
  };
}

export function detectCascade(logs: string): Detector | null {
  const timeoutRanks = new Set<number>();
  let culprit: { rank: number; line: string } | null = null;
  for (const line of logs.split("\n")) {
    const m = line.match(/\brank[:\s]*(\d+)/i) || line.match(/\[(\d+)\]/);
    const rank = m ? parseInt(m[1]!, 10) : null;
    if (rank !== null && COLLATERAL.test(line)) timeoutRanks.add(rank);
    if (culprit === null && rank !== null && PRIMARY_FAULT.test(line)) culprit = { rank, line: line.trim().slice(0, 200) };
  }
  const n = timeoutRanks.size;
  if (!((culprit && n >= 1) || n >= 2)) return null;
  if (culprit) {
    return {
      id: "cascade",
      severity: "critical",
      summary: `Rank ${culprit.rank} failed first; ${n} other rank(s) then hit NCCL timeouts waiting on it. The originating fault is rank ${culprit.rank}, the timeouts elsewhere are collateral.`,
      action: `Focus on rank ${culprit.rank} (the culprit), ignore the timeout errors on the other ranks. Roll back, fix the root fault on that rank's GPU/node, then re-launch.`,
    };
  }
  return {
    id: "cascade",
    severity: "critical",
    summary: `${n} ranks reporting NCCL collective timeouts, a hang/cascade with no single primary fault line.`,
    action: "Localize the first rank to stop heart-beating (compare per-rank log timestamps); the others are blocked waiting on it.",
  };
}

export function detectors(logs: string): Detector[] {
  return [detectCascade(logs), routeXid(logs)].filter((d): d is Detector => d !== null);
}

// ── Pattern + encyclopedia matching ──────────────────────────────────────────
function matchPattern(logs: string): PatternEntry | null {
  for (const { re, required, negative, p } of buildEngine().patterns) {
    re.lastIndex = 0;
    if (!re.test(logs)) continue;
    const evidence = required.map((gate) => {
      gate.lastIndex = 0;
      return gate.test(logs);
    });
    if (evidence.length && (p.requiredEvidenceMode === "all" ? evidence.some((ok) => !ok) : !evidence.some(Boolean))) continue;
    if (negative.some((gate) => {
      gate.lastIndex = 0;
      return gate.test(logs);
    })) continue;
    return p;
  }
  return null;
}

function causalEvidence(required: RegExp[][], logs: string): string[] {
  const spans: string[] = [];
  for (const group of required) {
    let match: RegExpExecArray | null = null;
    for (const regex of group) {
      regex.lastIndex = 0;
      match = regex.exec(logs);
      if (match) break;
    }
    if (!match) continue;
    const start = logs.lastIndexOf("\n", match.index) + 1;
    const newline = logs.indexOf("\n", match.index + match[0].length);
    const end = newline < 0 ? logs.length : newline;
    const quote = logs.slice(start, end).trim().slice(0, 520);
    if (quote && !spans.includes(quote)) spans.push(quote);
  }
  return spans.slice(0, 4);
}

export function matchCausalContract(logs: string): Omit<LocalDiagnosis, "detectors"> | null {
  const matches = buildEngine().causalContracts.filter(({ required, excluded }) => {
    const allGroups = required.every((group) => group.some((regex) => {
      regex.lastIndex = 0;
      return regex.test(logs);
    }));
    if (!allGroups) return false;
    return !excluded.some((regex) => {
      regex.lastIndex = 0;
      return regex.test(logs);
    });
  });
  if (matches.length === 0) return null;

  matches.sort((a, b) =>
    (b.contract.confidence - a.contract.confidence) || (b.required.length - a.required.length));
  const winner = matches[0]!;
  const competingOwners = matches
    .slice(1)
    .filter(({ contract }) => contract.confidence >= 75)
    .map(({ contract }) => contract.id);
  const confidence = competingOwners.length > 0 && winner.contract.confidence >= 75
    ? Math.min(winner.contract.confidence, 65)
    : winner.contract.confidence;

  return {
    failureType: winner.contract.failureType,
    confidence,
    summary: winner.contract.summary,
    action: winner.contract.action,
    fallbackAction: winner.contract.fallbackAction ?? null,
    resumeFrom: winner.contract.resumeFrom ?? null,
    severity: winner.contract.severity ?? "critical",
    isHealthy: Boolean(winner.contract.isHealthy),
    source: "local-causal-contract",
    evidence: causalEvidence(winner.required, logs),
    causalContract: winner.contract.id, ...(competingOwners.length > 0 ? { competingOwners } : {}),
  };
}

function calibrate(score: number, anchored: boolean): number {
  let c = score >= 0.6 ? 88 : score >= 0.45 ? 80 : score >= 0.32 ? 72 : score >= 0.22 ? 63 : 54;
  if (!anchored) c = Math.min(c, 74);
  return c;
}

interface Ranked {
  e: EncyclopediaEntry;
  score: number;
  shared: string[];
}

function rankEncyclopedia(text: string, k: number): Ranked[] {
  const eng = buildEngine();
  const ltoks = new Set(tokenize(text));
  if (ltoks.size === 0) return [];

  const lw = new Map<string, number>();
  let lsq = 0;
  for (const t of ltoks) {
    const w = eng.idf(t);
    lw.set(t, w);
    lsq += w * w;
  }
  const lnorm = Math.sqrt(lsq) || 1;
  const lanch = anchorsOf(text);

  const scored: Ranked[] = [];
  for (const it of eng.index) {
    let dot = 0;
    for (const [t, w] of lw) {
      const ew = it.weights.get(t);
      if (ew) dot += w * ew;
    }
    const cos = dot / (lnorm * it.norm);
    const shared: string[] = [];
    for (const a of lanch) if (it.anchors.has(a)) shared.push(a);
    const score = Math.min(1, cos + Math.min(0.42, 0.18 * shared.length));
    if (score < 0.12 && shared.length === 0) continue;
    scored.push({ e: it.e, score, shared });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function matchEncyclopedia(logs: string): EncyclopediaHit | null {
  const top = rankEncyclopedia(logs, 1)[0];
  if (!top) return null;
  if (top.score < 0.2 && top.shared.length === 0) return null;
  return {
    slug: top.e.slug,
    title: top.e.title,
    category: top.e.category,
    confidence: calibrate(top.score, top.shared.length > 0),
    action: top.e.action,
    steps: top.e.steps,
    evidence: top.shared.length ? [`signature: ${[...top.shared].sort().join(", ")}`] : [],
  };
}

// ── Public API ───────────────────────────────────────────────────────────────
export function localDiagnose(logs: string): LocalDiagnosis {
  const dets = detectors(logs);
  const causal = matchCausalContract(logs);
  let deferredCausal: typeof causal = null;
  if (causal && (causal.confidence >= 75 || causal.isHealthy)) {
    return { ...causal, detectors: dets };
  }
  if (causal) deferredCausal = causal;

  // Operational overrides run before the large generated corpus. The corpus
  // contains generic MPI/shared-memory entries that can also match PyTorch's
  // DataLoader SIGBUS wording; the framework + worker + full /dev/shm evidence
  // is more specific and must win regardless of corpus ordering.
  if (
    /DataLoader worker[\s\S]{0,160}(?:Bus error|signal:\s*Bus error)/i.test(logs)
    && /(?:insufficient shared memory|\/dev\/shm[\s\S]{0,80}(?:100%|full)|shm)/i.test(logs)
  ) {
    return {
      failureType: "DATALOADER_SHM_BUS_ERROR",
      confidence: 99,
      summary: "PyTorch DataLoader workers exhausted the container or pod shared-memory mount and were killed with SIGBUS.",
      action: "Increase /dev/shm (Docker --shm-size or a Kubernetes memory-backed emptyDir), then reduce num_workers/prefetch_factor if shared-memory pressure remains and confirm df -h /dev/shm has headroom before retrying.",
      source: "local-pattern",
      evidence: logs.split(/\r?\n/).filter((line) => /DataLoader|Bus error|\/dev\/shm|shared memory/i.test(line)).slice(0, 4),
      detectors: dets,
    };
  }

  const p = matchPattern(logs);
  if (p) {
    return {
      failureType: p.type,
      confidence: p.confidence,
      summary: p.summary,
      action: p.action,
      resumeFrom: p.resumeFrom ?? null,
      source: "local-pattern",
      detectors: dets,
    };
  }

  if (deferredCausal) return { ...deferredCausal, detectors: dets };

  const enc = matchEncyclopedia(logs);
  if (enc) {
    return {
      failureType: enc.slug.toUpperCase().replace(/-/g, "_"),
      confidence: enc.confidence,
      summary: `${enc.title} (${enc.category})`,
      action: enc.action,
      steps: enc.steps,
      evidence: enc.evidence,
      source: "local-encyclopedia",
      detectors: dets,
    };
  }

  if (dets.length) {
    const d = dets[0]!;
    return {
      failureType: d.id.toUpperCase(),
      confidence: 70,
      summary: d.summary,
      action: d.action,
      source: "local-detector",
      detectors: dets,
    };
  }

  return {
    failureType: "UNKNOWN",
    confidence: 0,
    summary: "No deterministic match. (The LLM fallback is cloud-only and unavailable in air-gapped mode.)",
    action: "Set DENPEX_API_KEY to use the cloud LLM fallback on novel errors, or file the failure from the dashboard so a pattern can be added.",
    source: "local",
    detectors: dets,
  };
}

// Search the generated published encyclopedia by free-text query or error code (offline).
export function searchEncyclopedia(query: string, k = 5): EncyclopediaHit[] {
  return rankEncyclopedia(query, k).map((r) => ({
    slug: r.e.slug,
    title: r.e.title,
    category: r.e.category,
    confidence: calibrate(r.score, r.shared.length > 0),
    action: r.e.action,
    steps: r.e.steps,
    evidence: r.shared.length ? [`signature: ${[...r.shared].sort().join(", ")}`] : [],
  }));
}

export function listEncyclopedia(): Array<{ slug: string; title: string; category: string }> {
  return DB.encyclopedia.map((e) => ({ slug: e.slug, title: e.title, category: e.category }));
}

export function getEncyclopediaEntry(slug: string): EncyclopediaEntry | null {
  return DB.encyclopedia.find((e) => e.slug === slug) ?? null;
}

export function engineInfo(): { patterns: number; causalContracts: number; classes: number } {
  const eng = buildEngine();
  return { patterns: eng.patterns.length, causalContracts: eng.causalContracts.length, classes: eng.count };
}
