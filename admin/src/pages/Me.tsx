import { LogOut } from 'lucide-react';
import { deviceText } from './Sessions';
import { api, ApiError } from '../api';
import { formatDateTime, formatRelative, ROLE_HINT, roleLabel, sourceInfo } from '../format';
import { topRole } from '../access';
import { AccessByAccount, useAccounts, type AccountBrief } from '../accountsView';
import { useLoad } from '../hooks';
import { confirmDialog, toast, toastError, useMe } from '../store';
import type { Me, Session } from '../types';
import { Avatar, Badge, Button, Card, DeviceLabel, Empty, PageHeader, Spinner } from '../ui';

export function MePage() {
  const me = useMe();
  // `GET /api/me/sessions` is optional on the server: when it is missing (404) the section is hidden.
  const sessions = useLoad<Session[] | null>(
    () =>
      api.mySessions().catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
        throw e;
      }),
    [],
  );
  const accounts = useMyAccounts(me);
  if (!me) return null;
  const { user, access } = me;
  const role = topRole(me);

  const revoke = async (s: Session) => {
    const ok = await confirmDialog({
      title: 'Đăng xuất thiết bị này?',
      message: `${deviceText(s)} (IP ${s.ip || '—'}) sẽ phải đăng nhập lại.`,
      confirmLabel: 'Đăng xuất',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeMySession(s.id);
      toast('Đã đăng xuất thiết bị');
      sessions.setData((prev) => prev?.filter((x) => x.id !== s.id));
    } catch (e) {
      toastError(e);
    }
  };

  const revokeOthers = async () => {
    const others = sessions.data?.filter((x) => !x.current) ?? [];
    const ok = await confirmDialog({
      title: 'Đăng xuất khỏi mọi thiết bị khác?',
      message: `${others.length} thiết bị / trình duyệt khác sẽ bị đăng xuất và phải đăng nhập lại. Phiên bạn đang dùng vẫn giữ.`,
      confirmLabel: 'Đăng xuất tất cả',
      danger: true,
    });
    if (!ok) return;
    try {
      for (const x of others) await api.revokeMySession(x.id);
      toast('Đã đăng xuất các phiên khác');
    } catch (e) {
      toastError(e);
    }
    void sessions.reload();
  };

  return (
    <div className="page page-narrow">
      <PageHeader title="Tài khoản của tôi" />
      <Card>
        <div className="profile">
          <Avatar name={user.displayName || user.username} size={56} />
          <div className="profile-text">
            <h2>{user.displayName || user.username}</h2>
            <div className="secondary">
              @{user.username}
              {user.email && <> · {user.email}</>}
            </div>
            <div className="badges">
              <Badge>{sourceInfo(user.source).label}</Badge>
              {user.isAdmin && <Badge tone="accent">Quản trị viên</Badge>}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Quyền của tôi">
        {role === 'admin' ? (
          <dl className="kv">
            <dt>Vai trò</dt>
            <dd>
              <Badge tone="accent">{roleLabel('admin')}</Badge>
              <div className="field-hint">{ROLE_HINT.admin} Áp dụng cho mọi tài khoản Zalo của máy chủ.</div>
            </dd>
          </dl>
        ) : role ? (
          <div className="stack">
            <span className="secondary small">Quyền của bạn trên từng tài khoản Zalo của máy chủ:</span>
            <AccessByAccount access={access} accounts={accounts} />
          </div>
        ) : (
          <Empty title="Bạn chưa được cấp quyền">Hãy nhờ quản trị viên máy chủ cấp quyền dùng tài khoản Zalo cho bạn.</Empty>
        )}
      </Card>

      {sessions.data !== null && (
        <Card
          title="Thiết bị và trình duyệt đang đăng nhập"
          pad={false}
          actions={
            (sessions.data?.filter((x) => !x.current).length ?? 0) > 0 && (
              <Button size="sm" variant="danger-ghost" onClick={revokeOthers}>
                Đăng xuất mọi phiên khác
              </Button>
            )
          }
        >
          {sessions.data === undefined ? (
            sessions.error ? (
              <div className="card-body secondary">{sessions.error instanceof Error ? sessions.error.message : ''}</div>
            ) : (
              <Spinner />
            )
          ) : sessions.data.length === 0 ? (
            <div className="card-body secondary">Không có thiết bị nào.</div>
          ) : (
            <ul className="list">
              {sessions.data.map((s) => (
                <li key={s.id} className="list-row">
                  <div className="device-row-main">
                    <DeviceLabel
                      kind={s.kind}
                      deviceName={s.deviceName}
                      deviceId={s.deviceId}
                      online={s.online}
                      sub={
                        <>
                          {s.kind === 'web' ? 'Trình duyệt · trang quản trị' : 'Ứng dụng Compola'}
                          {s.current && <Badge tone="accent">Phiên hiện tại</Badge>}
                        </>
                      }
                    />
                  </div>
                  <div className="device-row-meta device-meta">
                    <span>
                      IP <span className="mono">{s.ip || '—'}</span>
                    </span>
                    <span>Đăng nhập {formatDateTime(s.createdAt)}</span>
                    <span>{s.online ? <span className="ok-text">Đang trực tuyến</span> : `Hoạt động ${formatRelative(s.lastSeenAt).toLowerCase()}`}</span>
                  </div>
                  {!s.current && (
                    <Button size="sm" variant="danger-ghost" icon={<LogOut size={14} />} onClick={() => revoke(s)}>
                      <span className="hide-sm">Đăng xuất</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

/** Names of the accounts the signed-in user may see: from `/api/me` (`accounts`), plus the full list for admins. */
export function useMyAccounts(me: Me | null): Map<string, AccountBrief> {
  const admin = useAccounts(!!me?.user.isAdmin);
  const map = new Map<string, AccountBrief>();
  for (const a of me?.accountList ?? []) map.set(a.id, a);
  for (const a of admin.list) map.set(a.id, a);
  return map;
}
