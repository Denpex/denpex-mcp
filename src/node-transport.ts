import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Long JSON requests must not inherit fetch's separate five-minute header limit. */
export function requestLongJson(url: string, init: {
  method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; timeoutMs: number;
}): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(target, { method: init.method, headers: init.headers,
      signal: init.signal, timeout: init.timeoutMs }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 20_000_000) {
          request.destroy(new Error('Diagnosis response exceeds the supported size'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Diagnosis response ended before completion')));
      response.on('end', () => {
        const status = response.statusCode || 502;
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(Object.assign(new Error('Request timed out'), { name: 'AbortError' })));
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}
