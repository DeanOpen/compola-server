// How an audit entry reads: one sentence, "<person> <did something> <to what>" (Customer.io "Audit Logs"), with the
// actor as a person (display name + @username) and any device shown as a device (name + short device id + IP).
import type { ReactNode } from 'react';
import { actionLabel } from './format';
import type { AuditEntry, User } from './types';
import { DeviceId } from './ui';

type Detail = Record<string, unknown>;

export function asDetail(d: AuditEntry['detail']): Detail | null {
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Detail) : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

const KEY_LABEL: Record<string, string> = {
  method: 'Cách',
  provider: 'Nguồn',
  reason: 'Lý do',
  source: 'Nguồn tài khoản',
  isAdmin: 'Quản trị',
  disabled: 'Khóa',
  role: 'Vai trò',
  name: 'Tên',
  members: 'Thành viên',
  count: 'Số lượng',
};

const VALUE_LABEL: Record<string, string> = {
  password: 'mật khẩu',
  sso: 'SSO',
  'owner-link': 'liên kết của chủ máy',
  'one-time link': 'liên kết một lần',
  device: 'ứng dụng',
  web: 'trình duyệt',
  true: 'có',
  false: 'không',
  viewer: 'Người xem',
  agent: 'Nhân viên',
};

// Keys rendered in the sentence (device / owner), not repeated in the detail summary.
const CONSUMED = new Set(['deviceId', 'deviceName', 'deviceIp', 'userId', 'kind', 'own', 'approved']);

/** The actor as a person; null for unauthenticated events (failed sign-in). */
export function actorUser(e: AuditEntry, userById: Map<string, User>): { username: string; displayName?: string } | null {
  if (!e.actor) return null;
  return userById.get(e.actor.userId) ?? { username: e.actor.username };
}

function PersonName({ user }: { user: { username: string; displayName?: string } | null }) {
  if (!user) return <span className="tertiary">Ai đó</span>;
  const name = user.displayName && user.displayName !== user.username ? user.displayName : null;
  return (
    <span className="audit-person">
      <strong>{name ?? `@${user.username}`}</strong>
      {name && <span className="secondary"> (@{user.username})</span>}
    </span>
  );
}

function DeviceInline({ name, id, ip, kind }: { name: string; id?: string; ip?: string; kind?: string }) {
  return (
    <span className="audit-device">
      <strong>{name || (kind === 'web' ? 'Trình duyệt' : 'thiết bị')}</strong>
      {kind === 'web' && name !== 'Trình duyệt' && <span className="secondary"> (trình duyệt)</span>} <DeviceId id={id} />
      {ip && <span className="secondary mono small"> · {ip}</span>}
    </span>
  );
}

const T = ({ children }: { children: ReactNode }) => <strong>{children}</strong>;

/** The predicate of the sentence (what the actor did), in Vietnamese. */
function predicate(e: AuditEntry, userById: Map<string, User>): ReactNode {
  const d = asDetail(e.detail);
  const target = e.target;
  const device = (fallbackName: string) => (
    <DeviceInline name={str(d?.deviceName) || fallbackName} id={str(d?.deviceId)} ip={str(d?.deviceIp)} kind={str(d?.kind)} />
  );
  const [head, ...rest] = e.action.split('.');
  const verb = rest.join('.');
  switch (e.action) {
    case 'login':
      if (target === 'link' || target === 'owner') return <>đã đăng nhập bằng <T>liên kết một lần</T> từ ứng dụng Compola</>;
      return <>đã đăng nhập{target && <> qua <T>{target}</T></>}</>;
    case 'zalo.qr':
      return <>đã lấy mã QR mới để đăng nhập Zalo cho máy chủ</>;
    case 'zalo.logout':
      return <>đã đăng xuất tài khoản Zalo{target && <> <T>{target}</T></>} khỏi máy chủ</>;
    case 'zalo.retry':
      return <>đã cho máy chủ thử chuẩn bị lại phần lõi Zalo</>;
    case 'login.failed':
      return <>đăng nhập thất bại{target && <> với <T>{target}</T></>}</>;
    case 'logout':
      return <>đã đăng xuất {device(target)}</>;
    case 'session.revoke': {
      const ownerId = str(d?.userId);
      const owner = ownerId && ownerId !== e.actor?.userId ? userById.get(ownerId) : undefined;
      if (d?.own || !ownerId || ownerId === e.actor?.userId) return <>đã đăng xuất thiết bị của mình: {device(target)}</>;
      return (
        <>
          đã đăng xuất {device(target)} của <PersonName user={owner ?? { username: ownerId }} />
        </>
      );
    }
    case 'device.approve':
      return (
        <>
          đã {d && d.approved === false ? 'từ chối' : 'cho phép'} {device('thiết bị')} đăng nhập{target && <> (mã <span className="mono">{target}</span>)</>}
        </>
      );
    case 'user.create':
      return <>đã tạo người dùng <T>@{target}</T></>;
    case 'user.update':
      return <>đã sửa người dùng <T>@{target}</T></>;
    case 'user.delete':
      return <>đã xóa người dùng <T>@{target}</T></>;
    case 'user.password':
      return <>đã đặt lại mật khẩu của <T>@{target}</T></>;
    case 'group.members':
      return <>đã đổi thành viên nhóm <T>{target}</T></>;
    case 'server.update':
      return <>đã sửa cài đặt máy chủ</>;
    case 'message.send':
      return <>đã gửi tin nhắn trong <T>{target}</T></>;
    case 'denied':
      return <>bị phân quyền chặn khi làm <span className="mono">{target}</span></>;
  }
  const verbs: Record<string, string> = { create: 'đã tạo', update: 'đã sửa', delete: 'đã xóa', test: 'đã kiểm tra' };
  if (head === 'group' && verbs[verb]) return <>{verbs[verb]} nhóm <T>{target}</T></>;
  if (head === 'provider' && verbs[verb]) return <>{verbs[verb]} nguồn đăng nhập <T>{target}</T></>;
  if (head === 'grant') {
    const g: Record<string, string> = { create: 'đã cấp quyền cho', update: 'đã sửa quyền của', delete: 'đã thu hồi quyền của' };
    if (g[verb]) return <>{g[verb]} <T>{target}</T></>;
  }
  if (head === 'call') return <>đã thao tác <span className="mono">{verb}</span>{target && <> trong <T>{target}</T></>}</>;
  return (
    <>
      {actionLabel(e.action).toLowerCase()}
      {target && <> · <T>{target}</T></>}
    </>
  );
}

export function AuditSentence({ entry, userById }: { entry: AuditEntry; userById: Map<string, User> }) {
  if (!entry.actor && entry.action === 'login.failed')
    return (
      <span className="audit-sentence">
        Đăng nhập thất bại{entry.target && <> với <T>{entry.target}</T></>}
      </span>
    );
  return (
    <span className="audit-sentence">
      <PersonName user={actorUser(entry, userById)} /> {predicate(entry, userById)}
    </span>
  );
}

/** Remaining detail fields as "Nhãn: giá trị · …". */
export function auditDetail(e: AuditEntry): string {
  const d = asDetail(e.detail);
  if (!d) return str(e.detail);
  return Object.entries(d)
    .filter(([k, v]) => !CONSUMED.has(k) && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const value = typeof v === 'object' ? JSON.stringify(v) : VALUE_LABEL[String(v)] ?? String(v);
      return `${KEY_LABEL[k] ?? k}: ${value}`;
    })
    .join(' · ');
}

