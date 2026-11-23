import { AlertTriangle, ArrowRight, Copy, Info, KeyRound, MonitorSmartphone, Server, Settings, ShieldAlert, Users } from 'lucide-react';
import { api } from '../api';
import { actionLabel, actionTone, formatDateTime, formatRelative, PHASE_LABEL, phaseTone, serverHealth, toDate } from '../format';
import { useInterval, useLoad } from '../hooks';
import { toast } from '../store';
import { DataTable } from '../table';
import type { Address, Session } from '../types';
import { AuditSentence } from '../auditView';
import { Avatar, Badge, Card, DescriptionList, Empty, IconButton, Loadable, OnlineDot, PageHeader, Person, Stat, StatusDot } from '../ui';

export function addressText(a: Address): string {
  return typeof a === 'string' ? a : a.ip;
}

const DAY = 24 * 60 * 60 * 1000;

const ADDRESS_KIND: Record<string, string> = { lan: 'Mạng LAN', vpn: 'VPN', public: 'Công khai', local: 'Cục bộ', loopback: 'Cục bộ' };

function addressKind(ip: string, kind?: string): string {
  if (kind) return ADDRESS_KIND[kind.toLowerCase()] ?? kind;
  if (ip.startsWith('127.') || ip === 'localhost' || ip === '::1') return 'Cục bộ';
  return 'Mạng LAN';
}

function CopyInline({ value }: { value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Đã sao chép');
    } catch {
      toast('Không sao chép được', 'error');
    }
  };
  return (
    <span className="copy-inline">
      <code className="selectable" title={value}>
        {value}
      </code>
      <IconButton label="Sao chép" icon={<Copy size={14} />} onClick={copy} />
    </span>
  );
}

export function DashboardPage() {
  const server = useLoad(() => api.server(), []);
  const users = useLoad(() => api.users(), []);
  const sessions = useLoad(() => api.sessions(), []);
  // Enough history for the 24h failed sign-in count; the table shows the newest rows.
  const audit = useLoad(() => api.audit({ limit: 100 }), []);
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
  const now = Date.now();
  const failed24h = audit.data?.filter((e) => e.action === 'login.failed' && (toDate(e.at)?.getTime() ?? 0) > now - DAY).length;
  const recent = audit.data?.slice(0, 8);

  return (
    <div className="page">
      <PageHeader
        title="Tổng quan"
        subtitle="Tình trạng máy chủ, truy cập và hoạt động gần đây"
        actions={
          <a className="btn btn-secondary" href="#/settings">
            <Settings size={15} />
            <span>Cài đặt máy chủ</span>
          </a>
        }
      />
      <Loadable state={server}>
        {(s) => {
          const health = serverHealth(s);
          return (
            <>
              <div className="status-strip">
                <span className="status-strip-item">
                  <StatusDot tone={health.tone} />
                  <strong>{health.label}</strong>
                </span>
                <span className="status-strip-sep" />
                <span className="status-strip-item">
                  <Server size={14} />
                  <span className="truncate">{s.name}</span>
                </span>
                <span className="status-strip-sep" />
                <span className="status-strip-item nums">v{s.version}</span>
                <span className="status-strip-sep" />
                <span className="status-strip-item nums">
                  Cổng {s.listen.port} · {s.listen.allowNetwork ? 'mở cho mạng LAN' : 'chỉ máy này'}
                </span>
                {s.publicUrl && <CopyInline value={s.publicUrl} />}
              </div>
              {!s.publicUrl && (
                <a className="notice notice-warn" href="#/settings">
                  <AlertTriangle size={16} />
                  <span>
                    Chưa đặt <strong>địa chỉ công khai</strong>: đăng nhập SSO và liên kết đăng nhập thiết bị cần địa chỉ này.
                  </span>
                  <ArrowRight size={15} />
                </a>
              )}
              <div className="stats stats-4">
                <Stat
                  label="Người dùng"
                  icon={<Users />}
                  href="#/users"
                  value={users.data ? users.data.length : '—'}
                  sub={users.data ? `${users.data.filter((u) => u.isAdmin).length} quản trị · ${users.data.filter((u) => u.disabled).length} bị khóa` : undefined}
                />
                <Stat
                  label="Thiết bị trực tuyến"
                  icon={<MonitorSmartphone />}
                  href="#/sessions"
                  value={sessions.data ? online.length : '—'}
                  sub={sessions.data ? `của ${onlineByPerson.length} người` : undefined}
                />
                <Stat
                  label="Phiên đăng nhập"
                  icon={<KeyRound />}
                  href="#/sessions"
                  value={sessions.data ? sessions.data.length : '—'}
                  sub={
                    sessions.data
                      ? `${sessions.data.filter((x) => x.kind === 'device').length} ứng dụng · ${sessions.data.filter((x) => x.kind === 'web').length} trình duyệt`
                      : undefined
                  }
                />
                <Stat
                  label="Đăng nhập thất bại"
                  icon={<ShieldAlert />}
                  href="#/audit?action=login.failed"
                  tone={failed24h ? 'danger' : undefined}
                  value={failed24h ?? '—'}
                  sub="24 giờ qua"
                />
              </div>
              <div className="overview-grid">
                <Card title="Tài khoản Zalo">
                  {s.account ? (
                    <div className="stack">
                      <div className="account-panel">
                        <Avatar name={s.account.name || 'Zalo'} src={s.account.avatar} size={44} />
                        <div className="profile-text">
                          <h2>{s.account.name || 'Chưa có tên'}</h2>
                          <Badge tone={phaseTone(s.account.phase)} dot>
                            {PHASE_LABEL[s.account.phase] ?? s.account.phase}
                          </Badge>
                        </div>
                      </div>
                      {phaseTone(s.account.phase) !== 'ok' && (
                        <div className="account-hint">
                          <Info size={15} />
                          <span>Mở ứng dụng Compola trên máy chủ để đăng nhập Zalo. Đến khi đó, người dùng kết nối sẽ thấy máy chủ chưa đăng nhập.</span>
                        </div>
                      )}
                      <DescriptionList
                        items={[
                          { label: 'Đang sử dụng', value: sessions.data ? `${onlineByPerson.length} người · ${online.length} thiết bị` : '—' },
                          {
                            label: 'Quyền truy cập',
                            value: (
                              <a className="link" href="#/grants">
                                Xem phân quyền <ArrowRight size={13} className="inline-icon" />
                              </a>
                            ),
                          },
                          { label: 'Nhật ký Zalo', value: <a className="link" href="#/audit?action=call">Thao tác trên Zalo <ArrowRight size={13} className="inline-icon" /></a> },
                        ]}
                      />
                    </div>
                  ) : (
                    <p className="secondary">Máy chủ chưa đăng nhập tài khoản Zalo.</p>
                  )}
                </Card>
                <Card title="Máy chủ" actions={<a className="link small" href="#/settings">Cài đặt</a>} pad={false}>
                  <div className="card-body">
                    <DescriptionList
                      items={[
                        { label: 'Tên', value: s.name },
                        { label: 'Địa chỉ công khai', value: s.publicUrl ? <CopyInline value={s.publicUrl} /> : <span className="tertiary">Chưa đặt</span> },
                        { label: 'Phạm vi', value: s.listen.allowNetwork ? <Badge tone="info">Mạng LAN</Badge> : <Badge>Chỉ máy này</Badge> },
                      ]}
                    />
                  </div>
                  {s.addresses.length > 0 && (
                    <div className="table-scroll">
                      <table className="table table-dense">
                        <thead>
                          <tr>
                            <th>Địa chỉ mạng</th>
                            <th>Loại</th>
                            <th className="col-actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {s.addresses.map((a) => {
                            const url = `http://${addressText(a)}:${s.listen.port}`;
                            return (
                              <tr key={url}>
                                <td className="cell-mono selectable">{url}</td>
                                <td>
                                  <span className="secondary">{addressKind(addressText(a), typeof a === 'string' ? undefined : a.kind)}</span>
                                </td>
                                <td className="col-actions">
                                  <CopyButton value={url} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              </div>
              <div className="overview-grid overview-grid-wide">
                <Card title="Hoạt động gần đây" actions={<a className="link small" href="#/audit">Xem nhật ký</a>} pad={false}>
                  <DataTable
                    bare
                    pageSize={0}
                    rows={recent}
                    loading={audit.loading}
                    rowKey={(e) => String(e.id)}
                    empty={<Empty title="Chưa có hoạt động" />}
                    columns={[
                      {
                        key: 'at',
                        header: 'Thời gian',
                        width: 120,
                        render: (e) => (
                          <span className="cell-time secondary" title={formatDateTime(e.at)}>
                            {formatRelative(e.at)}
                          </span>
                        ),
                      },
                      { key: 'action', header: 'Sự kiện', width: 170, render: (e) => <Badge tone={actionTone(e.action)}>{actionLabel(e.action)}</Badge> },
                      { key: 'what', header: 'Chi tiết', render: (e) => <AuditSentence entry={e} userById={userById} /> },
                      { key: 'ip', header: 'IP', width: 120, hideBelow: 1100, render: (e) => <span className="cell-mono">{e.ip || '—'}</span> },
                    ]}
                  />
                </Card>
                <Card
                  title={
                    <>
                      Đang trực tuyến <span className="tab-count">{online.length}</span>
                    </>
                  }
                  actions={<a className="link small" href="#/sessions">Tất cả thiết bị</a>}
                  pad={false}
                >
                  {onlineByPerson.length ? (
                    <div>
                      {onlineByPerson.map(([key, list]) => (
                        <div key={key} className="online-row">
                          <Person user={list[0].user} size={28} />
                          <span className="secondary small nowrap" style={{ marginLeft: 'auto' }}>
                            <OnlineDot online /> {list.length} thiết bị
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty icon={<MonitorSmartphone size={20} />} title={sessions.data ? 'Không có ai trực tuyến' : 'Đang tải…'} />
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Đã sao chép');
    } catch {
      toast('Không sao chép được', 'error');
    }
  };
  return <IconButton label="Sao chép" icon={<Copy size={14} />} onClick={copy} />;
}
