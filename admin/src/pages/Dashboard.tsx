import { AlertTriangle, ArrowRight, MessageCircle, MonitorSmartphone, Network, Server, Users } from 'lucide-react';
import { api } from '../api';
import { actionLabel, actionTone, formatRelative, PHASE_LABEL } from '../format';
import { useInterval, useLoad } from '../hooks';
import type { Address, Session } from '../types';
import { AuditSentence } from '../auditView';
import { Avatar, Badge, Card, CopyField, DeviceId, Loadable, OnlineDot, PageHeader, Person, Stat } from '../ui';

export function addressText(a: Address): string {
  return typeof a === 'string' ? a : a.ip;
}

export function DashboardPage() {
  const server = useLoad(() => api.server(), []);
  const users = useLoad(() => api.users(), []);
  const sessions = useLoad(() => api.sessions(), []);
  const audit = useLoad(() => api.audit({ limit: 8 }), []);
  useInterval(() => {
    void sessions.reload();
    void audit.reload();
    void server.reload();
  }, 20000);

  const online = sessions.data?.filter((s) => s.online) ?? [];
  const userById = new Map((users.data ?? []).map((u) => [u.id, u]));
  // Online sessions grouped by person (a person can be online on several devices).
  const byPerson = new Map<string, Session[]>();
  online.forEach((sess) => {
    const k = sess.user?.id ?? '?';
    byPerson.set(k, [...(byPerson.get(k) ?? []), sess]);
  });
  const onlineByPerson = [...byPerson.entries()];
  const onlineUsers = onlineByPerson.length;

  return (
    <div className="page">
      <PageHeader title="Tổng quan" subtitle={server.data ? `${server.data.name} · phiên bản ${server.data.version}` : undefined} />
      <Loadable state={server}>
        {(s) => (
          <>
            {!s.publicUrl && (
              <a className="notice notice-warn" href="#/settings">
                <AlertTriangle size={18} />
                <span>
                  Chưa đặt <strong>địa chỉ công khai</strong>: đăng nhập SSO và liên kết đăng nhập thiết bị cần địa chỉ này.
                </span>
                <ArrowRight size={16} />
              </a>
            )}
            <div className="stats">
              <Stat
                label="Người dùng"
                icon={<Users size={18} />}
                value={users.data ? users.data.length : '—'}
                sub={users.data ? `${users.data.filter((u) => u.isAdmin).length} quản trị · ${users.data.filter((u) => u.disabled).length} bị khóa` : undefined}
              />
              <Stat
                label="Thiết bị trực tuyến"
                icon={<MonitorSmartphone size={18} />}
                value={sessions.data ? online.length : '—'}
                sub={sessions.data ? `của ${onlineUsers} người · ${sessions.data.length} phiên đăng nhập` : undefined}
              />
              <Stat label="Cổng" icon={<Network size={18} />} value={s.listen.port} sub={s.listen.allowNetwork ? 'Mở cho mạng LAN' : 'Chỉ máy này'} />
            </div>
            <div className="grid-2">
              <Card title="Tài khoản Zalo" actions={<a className="link small" href="#/zalo">Quản lý</a>}>
                {s.account?.phase === 'ready' ? (
                  <div className="profile">
                    <Avatar name={s.account.name || 'Zalo'} src={s.account.avatar} size={52} />
                    <div className="profile-text">
                      <h2>{s.account.name || 'Tài khoản Zalo'}</h2>
                      <Badge tone="ok" dot>
                        Đã đăng nhập
                      </Badge>
                    </div>
                  </div>
                ) : (
                  <div className="profile">
                    <span className="zalo-status-icon">
                      <MessageCircle size={24} />
                    </span>
                    <div className="profile-text">
                      <h2>{s.account?.phase === 'login' ? 'Chưa đăng nhập Zalo' : PHASE_LABEL[s.account?.phase ?? ''] ?? 'Đang khởi động'}</h2>
                      <span className="secondary small">Người dùng Compola Server chưa dùng được tài khoản cho tới khi máy chủ đăng nhập.</span>
                      <a className="btn btn-primary btn-sm" href="#/zalo">
                        {s.account?.phase === 'login' ? 'Đăng nhập bằng mã QR' : 'Xem trạng thái'}
                      </a>
                    </div>
                  </div>
                )}
              </Card>
              <Card title="Máy chủ" actions={<a className="link small" href="#/settings">Cài đặt</a>}>
                <dl className="kv">
                  <dt>Tên</dt>
                  <dd>
                    <Server size={14} className="inline-icon" /> {s.name}
                  </dd>
                  <dt>Địa chỉ công khai</dt>
                  <dd>{s.publicUrl ? <CopyField value={s.publicUrl} /> : <span className="secondary">Chưa đặt</span>}</dd>
                  <dt>Địa chỉ mạng</dt>
                  <dd>
                    {s.addresses.length ? (
                      <div className="addr-list">
                        {s.addresses.map((a) => (
                          <code key={addressText(a)} className="selectable">
                            http://{addressText(a)}:{s.listen.port}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <span className="secondary">—</span>
                    )}
                  </dd>
                </dl>
              </Card>
            </div>
            <div className="grid-2">
              <Card title="Đang trực tuyến" actions={<a className="link small" href="#/sessions">Tất cả thiết bị</a>} pad={false}>
                {onlineByPerson.length ? (
                  <ul className="list">
                    {onlineByPerson.map(([key, list]) => (
                      <li key={key} className="list-row list-row-top">
                        <div className="online-person">
                          <Person user={list[0].user} source={userById.get(list[0].user?.id ?? '')?.source} size={30} />
                          <div className="online-devices">
                            {list.map((sess) => (
                              <span key={sess.id} className="online-device">
                                <OnlineDot online /> {sess.deviceName || (sess.kind === 'web' ? 'Trình duyệt' : 'Thiết bị')}{' '}
                                {sess.kind === 'web' ? <span className="secondary small">trang quản trị</span> : <DeviceId id={sess.deviceId} />}
                                <span className="secondary small mono"> {sess.ip}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="card-body secondary">{sessions.data ? 'Không có ai trực tuyến.' : 'Đang tải…'}</div>
                )}
              </Card>
              <Card title="Hoạt động gần đây" actions={<a className="link small" href="#/audit">Xem nhật ký</a>} pad={false}>
                {audit.data?.length ? (
                  <ul className="list">
                    {audit.data.map((e) => (
                      <li key={e.id} className="list-row list-row-top">
                        <span className="list-main">
                          <AuditSentence entry={e} userById={userById} />
                          <span className="audit-meta">
                            <Badge tone={actionTone(e.action)}>{actionLabel(e.action)}</Badge>
                            <span>{formatRelative(e.at)}</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="card-body secondary">{audit.data ? 'Chưa có hoạt động.' : 'Đang tải…'}</div>
                )}
              </Card>
            </div>
          </>
        )}
      </Loadable>
    </div>
  );
}
