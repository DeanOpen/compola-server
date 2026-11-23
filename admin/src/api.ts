// HTTP client of the admin console. Every /api request carries `X-Compola: 1` (the server refuses state-changing
// requests without it) and the session cookie. 401 → sign-in (the current route is remembered), 403 → "no permission".
// `?mock=1` (dev server) or VITE_ADMIN_MOCK=1 serves everything from an in-memory mock (./mock.ts), which is not part
// of a production build.

import type {
  AccountData,
  AuditEntry,
  DeviceInfo,
  EffectiveAccess,
  Grant,
  Group,
  Me,
  Provider,
  ProviderTestResult,
  PublicProviders,
  ServerInfo,
  Session,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type MockHandler = (method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown }>;

const MOCK_ALLOWED = import.meta.env.DEV || import.meta.env.VITE_ADMIN_MOCK === '1';

function mockRequested(): boolean {
  if (import.meta.env.VITE_ADMIN_MOCK === '1') return true;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mock') === '1') {
      sessionStorage.setItem('compola-admin-mock', '1');
      return true;
    }
    if (q.get('mock') === '0') sessionStorage.removeItem('compola-admin-mock');
    return sessionStorage.getItem('compola-admin-mock') === '1';
  } catch {
    return false;
  }
}

export const isMock = MOCK_ALLOWED && mockRequested();

let mockHandler: Promise<MockHandler> | null = null;
function mock(): Promise<MockHandler> {
  if (!mockHandler) mockHandler = import('./mock').then((m) => m.handle);
  return mockHandler;
}

let onUnauthorized: (() => void) | null = null;
/** Called on a 401 from any request not marked `auth: false` (App sends the user to sign-in). */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

interface Options {
  /** false: a 401 is an ordinary error (sign-in form, session probe) instead of "go to sign-in". */
  auth?: boolean;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Yêu cầu không hợp lệ.',
  401: 'Bạn cần đăng nhập lại.',
  403: 'Bạn không có quyền làm việc này.',
  404: 'Không tìm thấy.',
  409: 'Dữ liệu bị trùng hoặc đã thay đổi.',
  429: 'Thử quá nhiều lần. Vui lòng đợi một lúc.',
};

export async function request<T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  let status: number;
  let data: unknown;
  if (isMock) {
    const handler = await mock();
    const res = await handler(method, path, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
    status = res.status;
    data = res.body;
  } else {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: {
          'X-Compola': '1',
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Không kết nối được máy chủ Compola.');
    }
    status = res.status;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  }
  if (status >= 200 && status < 300) return data as T;
  const message =
    (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : null) ??
    STATUS_TEXT[status] ??
    `Lỗi máy chủ (${status}).`;
  if (status === 401 && opts.auth !== false) onUnauthorized?.();
  throw new ApiError(status, message);
}

/** Lists may come bare (`[...]`) or wrapped (`{users: [...]}`); accept both. */
function list<T>(value: unknown, ...keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    for (const k of [...keys, 'items', 'data']) {
      const v = (value as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/** Single objects may come bare or wrapped (`{user: {...}}`). */
function one<T>(value: unknown, key: string): T {
  if (value && typeof value === 'object' && key in (value as object)) {
    const v = (value as Record<string, unknown>)[key];
    if (v && typeof v === 'object') return v as T;
  }
  return value as T;
}

const enc = encodeURIComponent;

export interface UserInput {
  username: string;
  displayName: string;
  email: string;
  password?: string;
  isAdmin: boolean;
  /** Not in the doc's POST body: pre-creates an LDAP / OIDC user ("ldap:<id>" | "oidc:<id>"); absent = local. */
  source?: string;
}

export const api = {
  // Public / auth
  providers: () => request<PublicProviders>('GET', '/api/auth/providers', undefined, { auth: false }),
  login: (username: string, password: string, provider: string) =>
    request<unknown>('POST', '/api/auth/login', { username, password, provider }, { auth: false }).then((r) =>
      one<User>(r, 'user'),
    ),
  logout: () => request<unknown>('POST', '/api/auth/logout', {}, { auth: false }),
  me: () =>
    request<Partial<Me> & { user: User; session?: { id: string } | null }>('GET', '/api/me', undefined, { auth: false }).then(
      (r): Me => ({ user: r.user, sessionId: r.session?.id, access: { role: r.access?.role ?? null, scope: r.access?.scope ?? null } }),
    ),
  mySessions: () => request<unknown>('GET', '/api/me/sessions').then((r) => list<Session>(r, 'sessions')),
  revokeMySession: (id: string) => request<unknown>('DELETE', `/api/me/sessions/${enc(id)}`),

  /** Builds the URL that starts an OIDC / OAuth 2 sign-in; `next` is a path under /admin/. */
  oidcStartUrl(providerId: string, next: string, deviceCode?: string) {
    let url = `/api/auth/oidc/${enc(providerId)}/start?next=${enc(next)}`;
    if (deviceCode) url += `&device=${enc(deviceCode)}`;
    return url;
  },
  /** Mock mode only: what the IdP round trip would do. */
  mockOidc: (providerId: string) => request<unknown>('POST', '/__mock/oidc', { providerId }, { auth: false }),

  // Device sign-in
  deviceInfo: (code: string) => request<DeviceInfo>('GET', `/api/device/info?code=${enc(code)}`),
  deviceApprove: (userCode: string, approve: boolean) =>
    request<unknown>('POST', '/api/device/approve', { userCode, approve }),

  // Users
  users: () => request<unknown>('GET', '/api/admin/users').then((r) => list<User>(r, 'users')),
  createUser: (input: UserInput) => request<unknown>('POST', '/api/admin/users', input).then((r) => one<User>(r, 'user')),
  updateUser: (id: string, patch: Partial<Pick<User, 'displayName' | 'email' | 'isAdmin' | 'disabled'>>) =>
    request<unknown>('PATCH', `/api/admin/users/${enc(id)}`, patch),
  setPassword: (id: string, password: string) =>
    request<unknown>('POST', `/api/admin/users/${enc(id)}/password`, { password }),
  deleteUser: (id: string) => request<unknown>('DELETE', `/api/admin/users/${enc(id)}`),

  // Groups
  groups: () => request<unknown>('GET', '/api/admin/groups').then((r) => list<Group>(r, 'groups')),
  createGroup: (g: { name: string; description: string }) =>
    request<unknown>('POST', '/api/admin/groups', g).then((r) => one<Group>(r, 'group')),
  updateGroup: (id: string, patch: { name?: string; description?: string }) =>
    request<unknown>('PATCH', `/api/admin/groups/${enc(id)}`, patch),
  setGroupMembers: (id: string, userIds: string[]) =>
    request<unknown>('PUT', `/api/admin/groups/${enc(id)}/members`, { userIds }),
  deleteGroup: (id: string) => request<unknown>('DELETE', `/api/admin/groups/${enc(id)}`),

  // Grants
  grants: () => request<unknown>('GET', '/api/admin/grants').then((r) => list<Grant>(r, 'grants')),
  createGrant: (g: Omit<Grant, 'id' | 'createdAt'>) =>
    request<unknown>('POST', '/api/admin/grants', g).then((r) => one<Grant>(r, 'grant')),
  updateGrant: (id: string, patch: Partial<Omit<Grant, 'id' | 'createdAt'>>) =>
    request<unknown>('PATCH', `/api/admin/grants/${enc(id)}`, patch),
  deleteGrant: (id: string) => request<unknown>('DELETE', `/api/admin/grants/${enc(id)}`),
  access: (userId: string) => request<EffectiveAccess>('GET', `/api/admin/access/${enc(userId)}`),
  accountData: () =>
    request<Partial<AccountData>>('GET', '/api/admin/conversations').then((r) => ({
      conversations: r?.conversations ?? [],
      labels: r?.labels ?? [],
    })),

  // Providers
  adminProviders: () => request<unknown>('GET', '/api/admin/providers').then((r) => list<Provider>(r, 'providers')),
  createProvider: (p: Omit<Provider, 'id'>) =>
    request<unknown>('POST', '/api/admin/providers', p).then((r) => one<Provider>(r, 'provider')),
  updateProvider: (id: string, patch: Partial<Omit<Provider, 'id' | 'kind'>>) =>
    request<unknown>('PATCH', `/api/admin/providers/${enc(id)}`, patch),
  deleteProvider: (id: string) => request<unknown>('DELETE', `/api/admin/providers/${enc(id)}`),
  testProvider: (id: string, creds: { username?: string; password?: string }) =>
    request<ProviderTestResult>('POST', `/api/admin/providers/${enc(id)}/test`, creds),

  // Sessions
  sessions: () => request<unknown>('GET', '/api/admin/sessions').then((r) => list<Session>(r, 'sessions')),
  revokeSession: (id: string) => request<unknown>('DELETE', `/api/admin/sessions/${enc(id)}`),

  // Audit
  audit: (q: { limit?: number; before?: string | number; userId?: string; action?: string }) => {
    const p = new URLSearchParams();
    p.set('limit', String(q.limit ?? 100));
    if (q.before !== undefined && q.before !== '') p.set('before', String(q.before));
    if (q.userId) p.set('userId', q.userId);
    if (q.action) p.set('action', q.action);
    return request<unknown>('GET', `/api/admin/audit?${p}`).then((r) => list<AuditEntry>(r, 'entries', 'audit'));
  },

  // Server
  server: () => request<ServerInfo>('GET', '/api/admin/server'),
  updateServer: (patch: { name?: string; publicUrl?: string }) => request<unknown>('PATCH', '/api/admin/server', patch),
};
