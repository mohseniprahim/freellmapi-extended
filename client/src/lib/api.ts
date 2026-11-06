const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export const SESSION_EXPIRED_MESSAGE = 'انتهت جلسة الإدارة. يرجى تسجيل الدخول مجددًا ثم إعادة المحاولة.';

export class ApiSessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = 'ApiSessionExpiredError';
  }
}

/** Fetch follows the admin proxy's login redirect, which can return HTTP 200 HTML. */
export function assertApiSession(res: Response): void {
  const contentType = res.headers.get('Content-Type') ?? '';
  const isHtml = /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  const isLogin = /\/login\/?(?:[?#]|$)/i.test(res.url);
  if (res.redirected && (isHtml || isLogin)) {
    throw new ApiSessionExpiredError();
  }
}

export async function readApiJson<T>(res: Response): Promise<T> {
  assertApiSession(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });
  return readApiJson<T>(res);
}
