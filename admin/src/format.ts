// Vietnamese labels and formatting.
import type { MeRole, Provider, ServerInfo, Scope, Timestamp, UserSource } from './types';

export function toDate(t: Timestamp | null | undefined): Date | null {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return new Date(t < 1e12 ? t * 1000 : t);
  if (/^\d+$/.test(t)) return toDate(Number(t));
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDateTime(t: Timestamp | null | undefined): string {
  const d = toDate(t);
  if (!d) return '—';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatRelative(t: Timestamp | null | undefined): string {
  const d = toDate(t);
  if (!d) return 'Chưa bao giờ';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return 'Vừa xong';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} ngày trước`;
  return formatDateTime(t).slice(0, 10);
}

export const ROLE_LABEL: Record<string, string> = {
  admin: 'Quản trị viên',
  agent: 'Nhân viên',
  viewer: 'Người xem',
};

export const ROLE_HINT: Record<string, string> = {
  viewer: 'Chỉ xem tin nhắn; không gửi, thả cảm xúc, thu hồi, ghim hay quản lý nhóm.',
  agent: 'Xem và thao tác (gửi tin, trả lời, thả cảm xúc…) trong phạm vi được cấp.',
  admin: 'Quản trị máy chủ và thấy mọi cuộc trò chuyện với quyền nhân viên.',
};

export function roleLabel(role: MeRole | undefined): string {
  return role ? ROLE_LABEL[role] ?? role : 'Chưa có quyền';
}

export function sourceInfo(source: string, providers: Pick<Provider, 'id' | 'name'>[] = []): { label: string; kind: 'local' | 'ldap' | 'oidc' } {
  if (!source || source === 'local') return { label: 'Nội bộ', kind: 'local' };
  const [kind, id] = source.split(':') as ['ldap' | 'oidc', string];
  const p = providers.find((x) => x.id === id);
  const base = kind === 'ldap' ? 'LDAP' : 'SSO';
  return { label: p ? `${base} · ${p.name}` : base, kind: kind === 'ldap' ? 'ldap' : 'oidc' };
}

export function isLocal(source: UserSource | string) {
  return !source || source === 'local';
}

export function scopeSummary(scope: Scope | null | undefined): string {
  if (!scope) return 'Không có';
  if (scope.all) return 'Tất cả cuộc trò chuyện';
  const parts: string[] = [];
  if (scope.conversations.length) parts.push(`${scope.conversations.length} cuộc trò chuyện`);
  if (scope.labels.length) parts.push(`${scope.labels.length} nhãn`);
  return parts.length ? parts.join(' · ') : 'Không có cuộc trò chuyện nào';
}

export const ACTION_LABEL: Record<string, string> = {
  login: 'Đăng nhập',
  'login.failed': 'Đăng nhập thất bại',
  logout: 'Đăng xuất',
  'user.create': 'Tạo người dùng',
  'user.update': 'Sửa người dùng',
  'user.delete': 'Xóa người dùng',
  'user.password': 'Đặt lại mật khẩu',
  'group.create': 'Tạo nhóm',
  'group.update': 'Sửa nhóm',
  'group.delete': 'Xóa nhóm',
  'group.members': 'Đổi thành viên nhóm',
  'grant.create': 'Cấp quyền',
  'grant.update': 'Sửa quyền',
  'grant.delete': 'Thu hồi quyền',
  'provider.create': 'Thêm nguồn đăng nhập',
  'provider.update': 'Sửa nguồn đăng nhập',
  'provider.delete': 'Xóa nguồn đăng nhập',
  'provider.test': 'Kiểm tra nguồn đăng nhập',
  'session.revoke': 'Thu hồi phiên đăng nhập',
  'device.approve': 'Duyệt thiết bị',
  'device.deny': 'Từ chối thiết bị',
  'server.update': 'Sửa cài đặt máy chủ',
  'message.send': 'Gửi tin nhắn',
  denied: 'Bị chặn bởi phân quyền',
};

/** Actions offered in the audit filter. The server matches `action` exactly or as a prefix ("user" → "user.*"). */
export const ACTION_FILTERS: { value: string; label: string }[] = [
  { value: 'login', label: 'Đăng nhập (cả thất bại)' },
  { value: 'login.failed', label: 'Đăng nhập thất bại' },
  { value: 'logout', label: 'Đăng xuất' },
  { value: 'device', label: 'Duyệt thiết bị' },
  { value: 'session.revoke', label: 'Thu hồi phiên đăng nhập' },
  { value: 'user', label: 'Người dùng (mọi thay đổi)' },
  { value: 'group', label: 'Nhóm (mọi thay đổi)' },
  { value: 'grant', label: 'Phân quyền (mọi thay đổi)' },
  { value: 'provider', label: 'Nguồn đăng nhập (mọi thay đổi)' },
  { value: 'server', label: 'Cài đặt máy chủ' },
  { value: 'message.send', label: 'Gửi tin nhắn' },
  { value: 'call', label: 'Thao tác trên Zalo (mọi)' },
  { value: 'denied', label: 'Bị chặn bởi phân quyền' },
];

export function actionLabel(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  if (action.startsWith('call.')) return `Thao tác ${action.slice(5)}`;
  const [head] = action.split('.');
  const prefix: Record<string, string> = { user: 'Người dùng', group: 'Nhóm', grant: 'Phân quyền', provider: 'Nguồn đăng nhập' };
  return prefix[head] ? `${prefix[head]}: ${action.slice(head.length + 1)}` : action;
}

export type ActionTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
export function actionTone(action: string): ActionTone {
  if (action === 'denied' || action === 'login.failed') return 'danger';
  if (action.endsWith('.delete') || action === 'session.revoke') return 'warn';
  if (action === 'login' || action === 'device.approve') return 'ok';
  if (action.startsWith('call.') || action === 'message.send') return 'info';
  return 'neutral';
}

export const PHASE_LABEL: Record<string, string> = {
  ready: 'Đang hoạt động',
  online: 'Đang hoạt động',
  signedIn: 'Đang hoạt động',
  connected: 'Đang hoạt động',
  loading: 'Đang tải',
  starting: 'Đang khởi động',
  connecting: 'Đang kết nối',
  login: 'Chờ đăng nhập Zalo',
  qr: 'Chờ quét mã QR',
  signedOut: 'Chưa đăng nhập Zalo',
  loggedOut: 'Chưa đăng nhập Zalo',
  offline: 'Mất kết nối',
  error: 'Lỗi',
};

export function phaseTone(phase: string): ActionTone {
  if (['ready', 'online', 'signedIn', 'connected'].includes(phase)) return 'ok';
  if (['error', 'offline'].includes(phase)) return 'danger';
  return 'warn';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const s = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0];
  return s.toUpperCase();
}

export function detailText(detail: unknown): string {
  if (detail === null || detail === undefined || detail === '') return '';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** A short, readable form of an id (device ids are long): first 8 alphanumerics, upper case. */
export function shortId(id: string | null | undefined, n = 8): string {
  const c = (id ?? '').replace(/^[a-z]{1,3}_/i, '').replace(/[^a-zA-Z0-9]/g, '');
  return c.slice(0, n).toUpperCase();
}

/** Text form of a person: "Tên hiển thị (@username)". Never a device name. */
export function personText(u: { username: string; displayName?: string } | null | undefined): string {
  if (!u) return 'Người dùng đã xóa';
  return u.displayName && u.displayName !== u.username ? `${u.displayName} (@${u.username})` : `@${u.username}`;
}

export function deviceKindLabel(kind: string): string {
  return kind === 'web' ? 'Trình duyệt · trang quản trị' : 'Ứng dụng Compola';
}

/** One-line health of the server for the sidebar footer and the overview. */
export function serverHealth(s: ServerInfo): { tone: 'ok' | 'warn' | 'danger'; label: string } {
  if (!s.account) return { tone: 'warn', label: 'Chưa đăng nhập Zalo' };
  const tone = phaseTone(s.account.phase);
  const label = PHASE_LABEL[s.account.phase] ?? s.account.phase;
  return { tone: tone === 'ok' ? 'ok' : tone === 'danger' ? 'danger' : 'warn', label };
}
