// Thin HTTP client for the Denpex API. Authenticates with the engineer's API key
// via the `X-Denpex-Key` header (the API resolves the user + plan server-side -
// no JWT minting needed). Throws a typed DenpexError so tools can render friendly
// guidance instead of raw status codes.
import type { DenpexConfig } from "./config.js";
import { DenpexError } from "./errors.js";
import { requestLongJson } from "./node-transport.js";

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class DenpexClient {
  constructor(private readonly config: DenpexConfig) {}

  get baseUrl(): string {
    return this.config.apiUrl;
  }

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiKey) headers["X-Denpex-Key"] = this.config.apiKey;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    Object.assign(headers, opts.headers ?? {});

    try {
      const init = {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      };
      const endpoint = `${this.config.apiUrl}${path}`;
      const res = timeoutMs > 300_000
        ? await requestLongJson(endpoint, { ...init, timeoutMs })
        : await fetch(endpoint, init);
      const raw = await res.text();
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : undefined; }
      catch { parsed = raw; }
      if (!res.ok) throw new DenpexError(res.status, parsed, `HTTP ${res.status}`);
      return parsed as T;
    } catch (e) {
      if(e instanceof DenpexError)throw e;
      const err = e as { name?: string; message?: string };
      if (err?.name === "AbortError") {
        throw new DenpexError(504, null, "Request timed out");
      }
      throw new DenpexError(0, null, err?.message ?? "network error");
    } finally {
      clearTimeout(timer);
    }

  }
}
