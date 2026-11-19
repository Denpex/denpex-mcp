import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const DEFAULT_API_URL = "https://api.denpex.com";
const CODE_RE = /^DPXV-[0-9A-F]{32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONSUMER_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me",
  "gmx.com", "web.de", "mail.com", "zoho.com", "yandex.com", "qq.com",
  "163.com", "naver.com", "fastmail.com", "tutanota.com", "duck.com",
]);

export interface TrialKeyPair {
  key: string;
  keyHash: string;
  keyDisplay: string;
}

export interface StoredCredentials {
  apiKey: string;
  keyDisplay?: string;
  email?: string;
  plan?: string;
  apiUrl?: string;
  updatedAt?: string;
}

export function generateTrialKeyPair(): TrialKeyPair {
  const key = `dpx_${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(key).digest("hex");
  const keyDisplay = `${key.slice(0, 8)}...${key.slice(-4)}`;
  return { key, keyHash, keyDisplay };
}

export function validateWorkEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return "Enter a valid work email address (e.g. alex@yourcompany.com).";
  }
  const domain = email.split("@").pop() ?? "";
  if (CONSUMER_DOMAINS.has(domain)) {
    return `Team trials require a work email domain (e.g. @company.com, not @${domain}).`;
  }
  return null;
}

export function normalizeTrialCode(raw: string): string | null {
  const clean = raw.trim().toUpperCase();
  return CODE_RE.test(clean) ? clean : null;
}

export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = (env.DENPEX_CREDENTIALS_PATH ?? "").trim();
  if (override.toLowerCase() === "none") return undefined;
  if (override) return override;
  return join(homedir(), ".denpex", "credentials.json");
}

export function loadStoredApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const credPath = defaultCredentialsPath(env);
  if (!credPath || !existsSync(credPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(credPath, "utf8")) as Record<string, unknown>;
    const key = typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "";
    return /^(?:dpx|dpk)_[A-Za-z0-9_]{8,}$/.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

export function saveCredentialsFile(cred: StoredCredentials, filePath?: string): string {
  const target = filePath || defaultCredentialsPath() || join(homedir(), ".denpex", "credentials.json");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify({ ...cred, updatedAt: cred.updatedAt ?? new Date().toISOString() }, null, 2)}\n`;
  writeFileSync(target, payload, { encoding: "utf8", mode: 0o600 });
  return target;
}

export async function requestWorkEmailTrial(
  email: string,
  apiUrl = DEFAULT_API_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; sent: boolean; message: string; state?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const base = apiUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/api/trial/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: cleanEmail, source: "mcp-cli" }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const sent = res.ok && body.ok !== false && body.sent !== false;
  const msg = typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : sent
      ? `Verification code emailed to ${cleanEmail}.`
      : typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : `Request failed (HTTP ${res.status}).`;
  return {
    ok: res.ok && body.ok !== false,
    status: res.status,
    sent,
    message: msg,
    state: typeof body.state === "string" ? body.state : undefined,
  };
}

export async function activateWorkEmailTrial(options: {
  email: string;
  code: string;
  apiUrl?: string;
  keyPair?: TrialKeyPair;
  fetchImpl?: typeof fetch;
}): Promise<{
  ok: boolean;
  httpStatus: number;
  status: string;
  apiKey?: string;
  keyDisplay?: string;
  plan?: string;
  dailyCap?: number | null;
  expiresAt?: number | null;
  message: string;
}> {
  const cleanEmail = options.email.trim().toLowerCase();
  const cleanCode = normalizeTrialCode(options.code);
  if (!cleanCode) {
    return {
      ok: false,
      httpStatus: 400,
      status: "error",
      message: "Paste the whole code from your email. It starts with DPXV-.",
    };
  }
  const pair = options.keyPair ?? generateTrialKeyPair();
  const base = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
  const fetchFn = options.fetchImpl ?? fetch;
  const res = await fetchFn(`${base}/api/trial/activate-in-editor`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      email: cleanEmail,
      code: cleanCode,
      keyHash: pair.keyHash,
      keyDisplay: pair.keyDisplay,
      client: "mcp",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const replyStatus = typeof body.status === "string" ? body.status : (res.ok ? "active" : "error");
  const msg = typeof body.message === "string" && body.message.trim()
    ? body.message.trim()
    : typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : `Trial activation failed (HTTP ${res.status}).`;
  if (res.ok && replyStatus === "active") {
    return {
      ok: true,
      httpStatus: res.status,
      status: "active",
      apiKey: pair.key,
      keyDisplay: pair.keyDisplay,
      plan: typeof body.plan === "string" ? body.plan : "team",
      dailyCap: typeof body.daily_cap === "number" ? body.daily_cap : null,
      expiresAt: typeof body.expires_at === "number" ? body.expires_at : null,
      message: msg,
    };
  }
  return {
    ok: false,
    httpStatus: res.status,
    status: replyStatus,
    message: msg,
  };
}

export interface TrialCliIo {
  prompt?: (question: string) => Promise<string>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  fetchImpl?: typeof fetch;
  credentialsPath?: string;
}

export async function runTrialCli(argv: string[], io: TrialCliIo = {}): Promise<number> {
  const log = io.log ?? ((line: string) => console.log(line));
  const err = io.error ?? ((line: string) => console.error(line));
  const fetchImpl = io.fetchImpl ?? fetch;

  let email = "";
  let code = "";
  let apiUrl = (process.env.DENPEX_API_URL ?? "").trim() || DEFAULT_API_URL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      log("Usage: denpex-mcp trial [--email <work-email>] [--code <DPXV-...>] [--api-url <url>]");
      log("Start and activate a 30-day Denpex Team trial from the terminal without a browser.");
      return 0;
    }
    if (arg === "--email" && i + 1 < argv.length) {
      email = argv[++i] ?? "";
    } else if (arg === "--code" && i + 1 < argv.length) {
      code = argv[++i] ?? "";
    } else if (arg === "--api-url" && i + 1 < argv.length) {
      apiUrl = argv[++i] ?? apiUrl;
    }
  }

  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = io.prompt ?? (async (q: string) => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(q);
  });

  try {
    if (!email.trim()) {
      email = await ask("Work email (e.g. alex@yourcompany.com): ");
    }
    const emailErr = validateWorkEmail(email);
    if (emailErr) {
      err(`[denpex-mcp] ${emailErr}`);
      return 1;
    }
    const cleanEmail = email.trim().toLowerCase();

    if (!code.trim()) {
      log(`[denpex-mcp] Emailing verification code to ${cleanEmail}...`);
      const req = await requestWorkEmailTrial(cleanEmail, apiUrl, fetchImpl);
      if (!req.ok || !req.sent) {
        err(`[denpex-mcp] ${req.message}`);
        return 1;
      }
      log(`[denpex-mcp] Check ${cleanEmail} for your DPXV-... verification code.`);
      code = await ask("Paste the DPXV-... code from your email: ");
    }

    const cleanCode = normalizeTrialCode(code);
    if (!cleanCode) {
      err("[denpex-mcp] Paste the whole code from your email. It starts with DPXV- followed by 32 letters and digits.");
      return 1;
    }

    const pair = generateTrialKeyPair();
    const act = await activateWorkEmailTrial({
      email: cleanEmail,
      code: cleanCode,
      apiUrl,
      keyPair: pair,
      fetchImpl,
    });
    if (!act.ok || !act.apiKey) {
      err(`[denpex-mcp] ${act.message}`);
      return 1;
    }

    const savedAt = saveCredentialsFile(
      {
        apiKey: act.apiKey,
        keyDisplay: act.keyDisplay,
        email: cleanEmail,
        plan: act.plan,
        apiUrl,
      },
      io.credentialsPath,
    );
    log(`[denpex-mcp] ${act.message}`);
    log(`[denpex-mcp] Plan: ${act.plan ?? "team"} (${act.keyDisplay})`);
    log(`[denpex-mcp] Saved credential to ${savedAt} (denpex-mcp loads this automatically).`);
    log(`[denpex-mcp] Optional env config: DENPEX_API_KEY=${act.apiKey}`);
    return 0;
  } finally {
    rl?.close();
  }
}
