import { newIdempotencyKey } from './idempotencyKey';
import { CommandKeys } from './commandKeys';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
  constructor(message: string, code = 'NETWORK', status = 0, details?: Record<string, unknown>) {
    super(message); this.code = code; this.status = status; this.details = details;
  }
}
async function read<T>(response: Response): Promise<T> {
  let body: unknown = {};
  try { body = await response.json(); } catch { /* Empty and non-JSON error bodies are handled below. */ }
  if (!response.ok) {
    const data = body as { message?: string; error_code?: string; details?: Record<string, unknown> & { fields?: { field: string; message: string }[] } };
    const detail = data.details?.fields?.map(item => `${item.field}: ${item.message}`).join('；');
    throw new ApiError(`${data.message ?? (response.status === 401 ? '登录已失效，请重新登录' : '操作未完成，请检查输入后重试')}${detail ? `（${detail}）` : ''}`, data.error_code, response.status, data.details);
  }
  return body as T;
}
export async function api<T>(path: string): Promise<T> {
  return read<T>(await fetch(`/api/v1${path}`, { credentials: 'same-origin' }));
}
type RuntimeContext = { mode: 'demo' | 'pilot'; actor?: string; csrfToken?: string };
let runtime: RuntimeContext = { mode: 'demo', actor: localStorage.getItem('product-res-actor') ?? 'analyst' };
export function setClientContext(next: RuntimeContext): void { runtime = next; }

export async function authPost<T>(path: string, payload: Record<string, unknown>, csrfToken?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return read<T>(await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(payload) }));
}
// A network failure has an unknown outcome. Keep its key until the server returns
// a definitive response; a completed action always receives a fresh key next time.
const pending = new CommandKeys();
export async function command<T>(path: string, payload: Record<string, unknown>, key?: string): Promise<T> {
  const body = JSON.stringify(runtime.mode === 'demo' ? { actor_id: runtime.actor ?? 'analyst', ...payload } : payload);
  const identity = `${path}:${body}`;
  const requestKey = pending.begin(identity, newIdempotencyKey, key);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey };
  if (runtime.mode === 'pilot' && runtime.csrfToken) headers['X-CSRF-Token'] = runtime.csrfToken;
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST', credentials: 'same-origin', headers, body,
  });
  try {
    const result = await read<T>(response);
    pending.settle(identity, response.status);
    return result;
  } catch (error) {
    if (error instanceof ApiError) pending.settle(identity, response.status);
    throw error;
  }
}
export async function preview<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (runtime.mode === 'pilot' && runtime.csrfToken) headers['X-CSRF-Token'] = runtime.csrfToken;
  return read<T>(await fetch(`/api/v1${path}`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(payload) }));
}
