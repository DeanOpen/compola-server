// Shapes of the Compola Server HTTP API (docs/compola-server.md, "HTTP API").

/** Server timestamps: epoch milliseconds, epoch seconds or an ISO string (all accepted by `toDate`). */
export type Timestamp = number | string;

export type UserSource = 'local' | `ldap:${string}` | `oidc:${string}`;

export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string;
  source: UserSource;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: Timestamp;
  lastLoginAt: Timestamp | null;
}

export interface Group {
  id: string;
  name: string;
  description: string;
  source: 'local' | `ldap:${string}`;
  members: string[];
}

export type Role = 'viewer' | 'agent';

export interface Scope {
  all: boolean;
  conversations: string[];
  labels: string[];
}

export interface Subject {
  type: 'user' | 'group';
  id: string;
}

export interface Grant {
  id: string;
  subject: Subject;
  /** A Zalo account id, or "*" = every account (present and future; requires scope.all). */
  account: string;
  role: Role;
  scope: Scope;
  note: string;
  createdAt: Timestamp;
}

/** Access to one Zalo account: the highest role and the union of scopes over the user's and groups' grants. */
export interface AccountAccess {
  role: Role | 'admin';
  scope: Scope;
}

/** Access of a user over every Zalo account (`/api/me`, `/api/admin/access/<id>`). No key = no access there. */
export interface MultiAccess {
  admin: boolean;
  accounts: Record<string, AccountAccess>;
}

export interface EffectiveAccess extends MultiAccess {
  user?: UserBrief;
  via: { grantId: string; subject: Subject; account: string; role: Role; scope?: Scope }[];
}

export type MeRole = 'admin' | Role | null;

export interface Me {
  user: User;
  /** The session making the request (to mark "Phiên hiện tại"). */
  sessionId?: string;
  /** Never null here (the API's null is normalized to `{admin: false, accounts: {}}`). */
  access: MultiAccess;
  /** Summaries of the accounts the user may see, when the server sends them (`/api/me` → `accounts: [...]`). */
  accountList?: Pick<ZaloAccount, 'id' | 'name' | 'label' | 'avatar'>[];
}

export interface LdapConfig {
  url: string;
  startTls: boolean;
  bindDn: string;
  bindPassword: string;
  userBaseDn: string;
  userFilter: string;
  usernameAttr: string;
  displayNameAttr: string;
  emailAttr: string;
  groupBaseDn?: string;
  groupFilter?: string;
  groupNameAttr?: string;
  adminGroup?: string;
  autoCreate: boolean;
}

export interface OidcConfig {
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  emailClaim: string;
  groupsClaim?: string;
  adminGroup?: string;
  autoCreate: boolean;
}

export type Provider =
  | { id: string; kind: 'ldap'; name: string; enabled: boolean; config: LdapConfig }
  | { id: string; kind: 'oidc'; name: string; enabled: boolean; config: OidcConfig };

export type ProviderKind = Provider['kind'];

export interface PublicProviders {
  serverName: string;
  local: boolean;
  ldap: { id: string; name: string }[];
  oidc: { id: string; name: string }[];
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  user?: Partial<User> & Record<string, unknown>;
}

/** The short identity of a person (never a device). */
export interface UserBrief {
  id: string;
  username: string;
  displayName?: string;
}

/** One sign-in of a person on one device (joined Compola app) or browser (admin console). */
export interface Session {
  id: string;
  user: UserBrief | null;
  kind: 'web' | 'device';
  /** Stable per Compola install; empty for browser sessions. */
  deviceId: string;
  deviceName: string;
  ip: string;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt?: Timestamp;
  online: boolean;
  /** Optional: marks the session making the request (used by "Tài khoản của tôi" when present). */
  current?: boolean;
}

export interface AuditEntry {
  id: number | string;
  at: Timestamp;
  actor: { userId: string; username: string } | null;
  action: string;
  target: string;
  detail: string | Record<string, unknown> | null;
  ip: string;
}

export interface Conversation {
  id: string;
  name: string;
  isGroup: boolean;
  avatar: string;
  labels: string[];
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface AccountData {
  conversations: Conversation[];
  labels: Label[];
}

export type Address = string | { ip: string; kind?: string };

export interface ServerInfo {
  name: string;
  version: string;
  publicUrl: string;
  account: { name: string; avatar: string; phase: string } | null;
  listen: { port: number; allowNetwork: boolean };
  addresses: Address[];
}

/** A pending device sign-in request (`GET /api/device/info?code=`). */
export interface DeviceInfo {
  deviceName: string;
  deviceId: string;
  ip: string;
  createdAt: Timestamp;
}

// ---- The host's Zalo account (engine phase, as src-tauri/src/engine.rs `Phase` serializes it) ----

export type RuntimeStep = 'looking' | 'downloading' | 'verifying' | 'installing';

export interface RuntimeSetup {
  step: RuntimeStep;
  received?: number | null;
  total?: number | null;
  /** Why the last attempt failed; offer "Thử lại" (POST /api/admin/zalo/retry). */
  failure?: string | null;
}

export type LoginStep =
  | { kind: 'generating' }
  | { kind: 'waitingScan' }
  /** Phone scanned; waiting for "Đăng nhập" on the phone. */
  | { kind: 'waitingConfirm'; name: string; avatar?: string | null }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

export interface LoginState {
  step: LoginStep;
  /** A data URL (PNG or SVG). */
  qr: string | null;
  /** The server asked for a second scan (device linking). */
  isSecondQr: boolean;
}

export type ZaloPhase =
  | { kind: 'starting' }
  | { kind: 'preparing'; setup: RuntimeSetup }
  | { kind: 'login'; login: LoginState; notice?: string | null }
  | { kind: 'signingIn' }
  | { kind: 'ready' };

export interface ZaloStatus {
  /** null before the engine reported its first phase. */
  phase: ZaloPhase | null;
  account: { name: string; avatar: string; phase: string } | null;
}

// ---- Activity tracking (per staff): docs/compola-server.md "Activity tracking" ----

export interface ActivityEntry {
  id: number | string;
  at: Timestamp;
  /** Zalo account id; "" until multi-account lands. */
  account: string;
  /** The Zalo uid of that account, when known. */
  accountUid?: string | null;
  /** null = done directly in the host app. */
  user: UserBrief | null;
  device: { id: string; name: string; kind: 'device' | 'web' | 'host' };
  action: string;
  conversation: { id: string; name: string } | null;
  messageId: string | null;
  ok: boolean;
  responseMs: number | null;
  detail: Record<string, unknown> | null;
}

export interface ActivityStatsRow {
  key: string;
  label: string;
  sent: number;
  media: number;
  recalled: number;
  reactions: number;
  reads: number;
  opens: number;
  conversations: number;
  responses: number;
  avgResponseMs: number | null;
  medianResponseMs: number | null;
  p90ResponseMs: number | null;
}

export interface ActivityStats {
  rows: ActivityStatsRow[];
  totals: Omit<ActivityStatsRow, 'key' | 'label'> & Partial<Pick<ActivityStatsRow, 'key' | 'label'>>;
}

export type ActivityGroupBy = 'user' | 'day' | 'account' | 'conversation';

// ---- Multiple Zalo accounts (M5) ----

/** One Zalo account of the host (`GET /api/admin/accounts`). */
export interface ZaloAccount {
  id: string;
  /** The Zalo user id once signed in. */
  uid: string;
  /** The Zalo display name. */
  name: string;
  /** An admin-set display label ("" = use the Zalo name). */
  label: string;
  avatar: string;
  order: number;
  enabled: boolean;
  /** The account the host app shows. */
  active: boolean;
  /** Engine phase kind ("ready", "login", …), or the phase object. */
  phase: string | { kind: string };
  /** Unread count. */
  badge: number;
}

export interface ZaloAccounts {
  active: string;
  maxAccounts: number;
  accounts: ZaloAccount[];
}

export interface ZaloAccountDetail {
  account: ZaloAccount;
  phase: ZaloPhase | null;
}
