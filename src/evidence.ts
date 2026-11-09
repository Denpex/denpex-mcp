const EVIDENCE_RE = /error|fail|fatal|traceback|exception|assert|panic|segfault|xid|nvrm|ecc|fallen off the bus|nccl|cuda|oom|out of memory|timeout|nan\b|\binf\b|node_fail|killed|terminated|version|driver|kernel|container|slurm|kubernetes|rank|node|host|gpu|pci|topology|nvlink|nvswitch|infiniband|rdma|roce/i;
const CAUSAL_RE = /fatal|critical|traceback|exception|assert|panic|segfault|xid|uncorrectable|fallen off the bus|out of memory|watchdog timeout|crc mismatch|loss\s*=\s*(?:nan|inf)|insufficient|unhealthy|ibv_modify_qp|no space left|compil(?:e|ation) (?:error|failed)|no available memory|checksum mismatch|childfailederror|backendcompilerfailed|failedscheduling|input\/output error|nonfinite|divergence|first failure|initiator|caused by/i;
const MAX_LINE_CHARS = 2_000;

function clipLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const marker = ' [line clipped by Denpex] ';
  const side = Math.max(1, Math.floor((MAX_LINE_CHARS - marker.length) / 2));
  return `${line.slice(0, side)}${marker}${line.slice(-side)}`.slice(0, MAX_LINE_CHARS);
}

function addWindow(target: Map<number, number>, index: number, radius: number, priority: number, count: number): void {
  for (let i = Math.max(0, index - radius); i <= Math.min(count - 1, index + radius); i++) {
    target.set(i, Math.max(priority, target.get(i) ?? 0));
  }
}

export function selectEvidence(logs: string, max: number): { text: string; truncated: boolean } {
  if (logs.length <= max) return { text: logs, truncated: false };
  const lines = logs.split(/\r?\n/);
  const candidates = new Map<number, number>();
  for (let i = 0; i < Math.min(48, lines.length); i++) candidates.set(i, 300);
  for (let i = Math.max(0, lines.length - 96); i < lines.length; i++) candidates.set(i, 800);
  let foundFirst = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!EVIDENCE_RE.test(line)) continue;
    const causal = CAUSAL_RE.test(line);
    addWindow(candidates, i, causal ? 3 : 1, causal ? 1_000 : 700, lines.length);
    if (!foundFirst) {
      addWindow(candidates, i, 6, 1_100, lines.length);
      foundFirst = true;
    }
  }
  const warning = `[Denpex condensed input: input exceeded ${max.toLocaleString()} characters. Environment, causal, rank, topology, middle, and final-tail evidence were selected.]`;
  let used = warning.length;
  const selected = new Set<number>();
  for (const [index] of [...candidates].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const line = clipLine(lines[index] ?? '');
    if (used + line.length + 1 > max) continue;
    selected.add(index);
    used += line.length + 1;
  }
  return {
    text: [warning, ...[...selected].sort((a, b) => a - b).map((index) => clipLine(lines[index] ?? ''))].join('\n'),
    truncated: true,
  };
}
