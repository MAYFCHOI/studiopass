export class ApiError extends Error {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  constructor(status: number, body: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    super(body?.error ?? String(status));
    this.status = status;
    this.body = body;
  }
}

/** 같은 출처 /api 호출. 2xx 가 아니면 ApiError, 네트워크가 끊기면 fetch 의 TypeError 가 그대로 올라온다. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch('/api' + path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  if (!r.ok) throw new ApiError(r.status, body);
  return body as T;
}
