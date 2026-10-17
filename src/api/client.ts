export class ApiError extends Error {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  constructor(status: number, body: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    super(body?.error ?? String(status));
    this.status = status;
    this.body = body;
  }
}

/** 서버에 닿지 못함: 네트워크 끊김, 시간 초과, 또는 프록시가 api 를 찾지 못함(502/503/504, 배포·재시작 중). */
export class NetworkError extends Error {
  cause?: unknown;
  constructor(cause?: unknown) { super('NETWORK'); this.cause = cause; }
}
export const isOffline = (e: unknown) => e instanceof NetworkError || e instanceof TypeError;

export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 같은 출처 /api 호출. 2xx 가 아니면 ApiError, 서버에 닿지 못하면 NetworkError.
 * 와이파이는 붙었는데 인터넷이 없을 때 fetch 가 수십 초 매달리지 않도록 시간 제한을 둔다.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  let r: Response;
  let body: unknown = null;
  try {
    r = await fetch('/api' + path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    body = r.headers.get('content-type')?.includes('json') ? await r.json() : null;
  } catch (e) {
    throw new NetworkError(e); // TypeError (no network), TimeoutError/AbortError (timeout), or a body cut off mid-read
  }
  if (r.status === 502 || r.status === 503 || r.status === 504) throw new NetworkError(r.status);
  if (!r.ok) throw new ApiError(r.status, body);
  return body as T;
}
