// Read crash logs the way an ML engineer actually has them: pasted text, a path
// to a single log file, or a directory we scan for the newest training log. This
// is the "diagnose ./logs/train.err" magic, no copy-paste required.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { selectEvidence } from "./evidence.js";

export interface LogInput {
  logs?: string;
  file?: string;
  dir?: string;
}

// The API caps a request at 256 KB; condense above 200 KB so privacy masking and
// JSON framing never push us over.
export const MAX_LOG_BYTES = 200_000;

const LOG_EXTENSIONS = [".err", ".log", ".out", ".txt"];
const MIN_LOG_CHARS = 6;

export function condenseLogs(logs: string, max = MAX_LOG_BYTES): string {
  return selectEvidence(logs, max).text;
}

// Pick the most recently modified log-like file in a directory (non-recursive).
async function newestLogInDir(dir: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const candidates = entries
    .filter((e) => e.isFile() && LOG_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name));
  if (candidates.length === 0) {
    throw new Error(`No log files (${LOG_EXTENSIONS.join(", ")}) found in ${dir}.`);
  }
  const stats = await Promise.all(
    candidates.map(async (f) => ({ f, mtime: (await fs.stat(f)).mtimeMs })),
  );
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats[0]!.f;
}

export interface ResolvedLogs {
  text: string;
  source: string; // "inline", or the file path read
}

export const MAX_LOG_FILE_BYTES = 100 * 1024 * 1024;

async function readLogFile(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Choose a regular plain-text log file.");
    if (stat.size > MAX_LOG_FILE_BYTES) throw new Error("Log files must be 100 MB or smaller.");
    const decoder = new TextDecoder("utf-8", {fatal:true});
    let total = 0;
    let text = "";
    const stream = handle.createReadStream({highWaterMark:512 * 1024, autoClose:false});
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_LOG_FILE_BYTES) throw new Error("Log files must be 100 MB or smaller.");
      const decoded = decoder.decode(chunk, {stream:true});
      if (/[\u0000-\u0008\u000e-\u001a\u001c-\u001f]/.test(decoded)) throw new Error("Attach a plain-text log; binary files are not supported.");
      text += decoded;
      if (Buffer.byteLength(text, "utf8") > MAX_LOG_BYTES * 4) text = selectEvidence(text, MAX_LOG_BYTES * 4).text;
    }
    text += decoder.decode();
    return text;
  } finally { await handle.close(); }
}

// Resolve exactly one of {logs, file, dir} into raw log text (uncondensed).
export async function resolveLogs(input: LogInput): Promise<ResolvedLogs> {
  if (input.logs && input.logs.trim()) {
    return { text: input.logs, source: "inline" };
  }
  if (input.file) {
    const text = await readLogFile(input.file);
    return { text, source: input.file };
  }
  if (input.dir) {
    const file = await newestLogInDir(input.dir);
    const text = await readLogFile(file);
    return { text, source: file };
  }
  throw new Error("Provide one of: `logs` (paste), `file` (path to a log file), or `dir` (folder to scan for the newest *.err/*.log).");
}

// Guard only the hard floor. The API quality gate admits terse machine events.
export function assertEnoughLog(text: string): void {
  if (text.trim().length < MIN_LOG_CHARS) {
    throw new Error(`Need at least ${MIN_LOG_CHARS} characters of logs to diagnose; got ${text.trim().length}.`);
  }
}
