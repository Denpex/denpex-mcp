import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ options: null as any, callback: null as any, request: null as any }));
vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (_url: unknown, options: any, callback: any) => {
    const request = new EventEmitter() as any;
    state.options = options; state.callback = callback; state.request = request;
    request.write = vi.fn(); request.end = vi.fn();
    request.destroy = (error: Error) => { request.emit('error', error); return request; };
    options.signal.addEventListener('abort', () => request.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    return request;
  } };
});
import { DenpexClient } from './client';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function client() { return new DenpexClient({ apiUrl: 'https://api.denpex.com', local: false, privacy: 'off' }); }
function headers(status = 200) {
  const response = new EventEmitter() as any; response.statusCode = status;
  state.callback(response); return response;
}
describe('MCP long-request native transport', () => {
  it('accepts headers arriving after five minutes and waits for the complete JSON body', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const pending = client().request('/api/diagnose', { method: 'POST', body: { logs: 'fixture' }, timeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(310_000);
    expect(state.options.signal.aborted).toBe(false);
    expect(state.options.timeout).toBe(600_000);
    const response = headers();
    response.emit('data', Buffer.from('{"success":true,'));
    await vi.advanceTimersByTimeAsync(20_000);
    response.emit('data', Buffer.from('"diagnosisId":"fixture"}')); response.emit('end');
    await expect(pending).resolves.toEqual({ success: true, diagnosisId: 'fixture' });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a response body even when bytes continue arriving', async () => {
    vi.useFakeTimers();
    const pending = client().request('/api/diagnose', { timeoutMs: 600_000 });
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
    const response = headers();
    for (let i = 0; i < 10; i++) { response.emit('data', ' '); await vi.advanceTimersByTimeAsync(60_000); }
    await rejected;
    expect(state.options.signal.aborted).toBe(true);
  });
  it('preserves HTTP error status and payload on the long path', async () => {
    const pending = client().request('/api/diagnose', { timeoutMs: 600_000 });
    const response = headers(429); response.emit('data', '{"error":"Quota reached"}'); response.emit('end');
    await expect(pending).rejects.toMatchObject({ status: 429, body: { error: 'Quota reached' } });
  });
});
