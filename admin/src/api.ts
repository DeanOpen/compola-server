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
  ZaloStatus,
  MultiAccess,
  ZaloAccountDetail,
  ZaloAccounts,
  ActivityEntry,
  ActivityGroupBy,
  ActivityStats,
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

/** Access in the M5 shape `{admin, accounts}`. Also reads the older single-account shape `{role, scope}` (as the
 *  "default" account) and `null` (no access). */
export function normalizeAccess(raw: unknown, isAdmin: boolean): MultiAccess {
  const r = (raw ?? null) as { admin?: boolean; accounts?: MultiAccess['accounts']; role?: string | null; scope?: unknown } | null;
  if (r && r.accounts && typeof r.accounts === 'object') return { admin: !!r.admin || isAdmin, accounts: r.accounts };
  if (r && r.role) {
    const role = r.role as MultiAccess['accounts'][string]['role'];
    const scope = (r.scope as MultiAccess['accounts'][string]['scope'] | null) ?? { all: true, conversations: [], labels: [] };
    return { admin: role === 'admin' || isAdmin, accounts: { default: { role, scope } } };
  }
  return { admin: isAdmin, accounts: {} };
}

/** Filters shared by the activity endpoints (empty values are left out). `action` is exact or a prefix; several
 *  values are comma-separated (one category covers several actions). */
export type ActivityQuery = {
  userId?: string;
  account?: string;
  conversationId?: string;
  action?: string;
  from?: number;
  to?: number;
};

function activityParams(q: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

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
    request<{ user: User; session?: { id: string } | null; access?: unknown; accounts?: Record<string, string> | Me['accountList'] }>('GET', '/api/me', undefined, { auth: false }).then(
      (r): Me => ({
        user: r.user,
        sessionId: r.session?.id ?? undefined,
        access: normalizeAccess(r.access, r.user.isAdmin),
        // `accounts: {<id>: name}` (names of the accounts the user may see); a list of summaries is accepted too.
        accountList: Array.isArray(r.accounts)
          ? r.accounts
          : r.accounts && typeof r.accounts === 'object'
            ? Object.entries(r.accounts).map(([id, name]) => ({ id, name: String(name ?? ''), label: '', avatar: '' }))
            : undefined,
      }),
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
  access: (userId: string) =>
    request<EffectiveAccess & { role?: unknown }>('GET', `/api/admin/access/${enc(userId)}`).then(
      (r): EffectiveAccess => ({ ...normalizeAccess(r, false), user: r.user, via: r.via ?? [] }),
    ),
  /** Conversations and labels of one Zalo account (default: "default"). */
  accountData: (account?: string) =>
    request<Partial<AccountData>>('GET', `/api/admin/conversations${account ? `?account=${enc(account)}` : ''}`).then((r) => ({
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

  // Activity tracking
  activity: (q: ActivityQuery & { limit?: number; before?: string | number }) =>
    request<unknown>('GET', `/api/admin/activity?${activityParams({ ...q, limit: q.limit ?? 100 })}`).then((r) => list<ActivityEntry>(r, 'entries')),
  activityStats: (q: ActivityQuery & { groupBy: ActivityGroupBy }) =>
    request<ActivityStats>('GET', `/api/admin/activity/stats?${activityParams(q)}`),
  /** Downloads `/api/admin/activity/export.csv?<filters>` (a plain link: the cookie authenticates it). */
  async exportActivityCsv(q: ActivityQuery & { groupBy?: ActivityGroupBy }) {
    const path = `/api/admin/activity/export.csv?${activityParams(q)}`;
    if (!isMock) {
      const a = document.createElement('a');
      a.href = path;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const csv = await request<string>('GET', path);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'compola-activity.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // The host's Zalo account
  // Zalo accounts of the host (M5). `/api/admin/zalo*` stays an alias of "default".
  accounts: () =>
    request<Partial<ZaloAccounts>>('GET', '/api/admin/accounts').then(
      (r): ZaloAccounts => ({
        active: r?.active ?? 'default',
        maxAccounts: r?.maxAccounts ?? 1,
        accounts: [...(r?.accounts ?? [])].sort((a, b) => a.order - b.order),
      }),
    ),
  account: (id: string) => request<ZaloAccountDetail>('GET', `/api/admin/accounts/${enc(id)}`),
  addAccount: () => request<{ id: string }>('POST', '/api/admin/accounts', {}),
  accountQr: (id: string) => request<unknown>('POST', `/api/admin/accounts/${enc(id)}/qr`, {}),
  accountLogout: (id: string) => request<unknown>('POST', `/api/admin/accounts/${enc(id)}/logout`, {}),
  deleteAccount: (id: string) => request<unknown>('DELETE', `/api/admin/accounts/${enc(id)}`),
  updateAccount: (id: string, patch: { label?: string; enabled?: boolean }) => request<unknown>('PATCH', `/api/admin/accounts/${enc(id)}`, patch),
  reorderAccounts: (ids: string[]) => request<unknown>('PUT', '/api/admin/accounts/order', { ids }),

  zalo: () => request<ZaloStatus>('GET', '/api/admin/zalo'),
  zaloQr: () => request<unknown>('POST', '/api/admin/zalo/qr', {}),
  zaloLogout: () => request<unknown>('POST', '/api/admin/zalo/logout', {}),
  zaloRetry: () => request<unknown>('POST', '/api/admin/zalo/retry', {}),

  // Server
  server: () => request<ServerInfo>('GET', '/api/admin/server'),
  updateServer: (patch: { name?: string; publicUrl?: string }) => request<unknown>('PATCH', '/api/admin/server', patch),
};
