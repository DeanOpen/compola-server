// Tài khoản Zalo: the host's Zalo accounts (M5), so an admin can add, order, enable, rename and sign them in and out
// from the console (the host can run headless). #/zalo lists GET /api/admin/accounts (polled every 3 s); #/zalo/<id>
// is one account's sign-in / status page (GET /api/admin/accounts/<id>, polled every 2 s). The QR card copies the desktop app's
// LoginView (src/features/setup/LoginView.tsx) and the runtime checklist its RuntimeSetupView, so both read the same.
import { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, GripVertical, Pencil, Plus, QrCode, Trash2 } from 'lucide-react';
import { accountName, phaseKind } from '../access';
import { navigate, useRoute } from '../router';
import { AlertTriangle, Check, Loader2, Download, Info, Lock, LogOut, PackageCheck, RefreshCw, Search, ShieldCheck, Smartphone, X, type LucideIcon } from 'lucide-react';
import { api, ApiError } from '../api';
import { formatBytes, PHASE_LABEL } from '../format';
import { useInterval, useLoad } from '../hooks';
import { confirmDialog, toast, toastError } from '../store';
import type { LoginState, RuntimeSetup, ZaloAccount, ZaloPhase, ZaloStatus } from '../types';
import { Avatar, Badge, Button, cx, ErrorBox, Field, FormModal, Loadable, PageHeader, RowMenu, Spinner } from '../ui';

export function ZaloPage() {
  const route = useRoute();
  const id = route.path.startsWith('/zalo/') ? decodeURIComponent(route.path.slice('/zalo/'.length)) : null;
  return id ? <AccountDetail key={id} id={id} /> : <AccountList />;
}

// ---- The list (M5: several Zalo accounts on one host) ----

function phasePill(a: ZaloAccount): { tone: 'ok' | 'warn' | 'neutral' | 'danger'; label: string } {
  if (!a.enabled) return { tone: 'neutral', label: 'Đã tắt' };
  const k = phaseKind(a.phase);
  if (k === 'ready') return { tone: 'ok', label: 'Đã đăng nhập' };
  if (k === 'login') return { tone: 'warn', label: 'Chờ quét mã QR' };
  return { tone: 'warn', label: PHASE_LABEL[k] ?? 'Đang khởi động' };
}

function AccountList() {
  const list = useLoad(() => api.accounts(), []);
  useInterval(() => void list.reload(), 3000);
  const [renaming, setRenaming] = useState<ZaloAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const data = list.data;
  const accounts = data?.accounts ?? [];
  const full = !!data && accounts.length >= data.maxAccounts;

  const reorder = async (ids: string[]) => {
    list.setData((d) => (d ? { ...d, accounts: ids.map((id, i) => ({ ...d.accounts.find((a) => a.id === id)!, order: i })) } : d));
    try {
      await api.reorderAccounts(ids);
    } catch (e) {
      toastError(e);
    }
    void list.reload();
  };
  const move = (id: string, delta: number) => {
    const ids = accounts.map((a) => a.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  };
  const dropOn = (target: string) => {
    if (!drag || drag === target) return;
    const ids = accounts.map((a) => a.id).filter((x) => x !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    void reorder(ids);
  };

  const add = async () => {
    setAdding(true);
    try {
      const { id } = await api.addAccount();
      toast('Đã thêm tài khoản: quét mã QR để đăng nhập');
      navigate(`/zalo/${encodeURIComponent(id)}`);
    } catch (e) {
      toastError(e);
    } finally {
      setAdding(false);
    }
  };

  const setEnabled = async (a: ZaloAccount, enabled: boolean) => {
    if (!enabled) {
      const ok = await confirmDialog({
        title: `Tắt ${accountName(a)}?`,
        message: 'Người dùng Compola Server tạm thời không dùng được tài khoản này. Phiên Zalo vẫn được giữ; bật lại bất cứ lúc nào.',
        confirmLabel: 'Tắt tài khoản',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.updateAccount(a.id, { enabled });
      toast(enabled ? 'Đã bật tài khoản' : 'Đã tắt tài khoản');
      void list.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const logout = async (a: ZaloAccount) => {
    const ok = await confirmDialog({
      title: `Đăng xuất ${accountName(a)} khỏi máy chủ?`,
      message: 'Mọi người dùng Compola Server sẽ mất kết nối tới tài khoản này cho tới khi đăng nhập lại bằng mã QR.',
      confirmLabel: 'Đăng xuất Zalo',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.accountLogout(a.id);
      toast('Đã đăng xuất');
      void list.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async (a: ZaloAccount) => {
    const ok = await confirmDialog({
      title: `Xoá ${accountName(a)} khỏi máy chủ?`,
      message: 'Phiên Zalo và dữ liệu của tài khoản này trên máy chủ bị xoá; các quyền cấp riêng cho tài khoản này cũng mất. Không hoàn tác được.',
      confirmLabel: 'Xoá tài khoản',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteAccount(a.id);
      toast('Đã xoá tài khoản');
      void list.reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader
        title="Tài khoản Zalo"
        subtitle={
          data
            ? `${accounts.length}/${data.maxAccounts} tài khoản · ${accounts.filter((a) => phaseKind(a.phase) === 'ready').length} đã đăng nhập. Người dùng dùng các tài khoản này theo quyền ở mục Phân quyền.`
            : 'Các tài khoản Zalo mà máy chủ dùng chung cho người dùng Compola Server'
        }
        actions={
          <Button variant="primary" icon={<Plus size={16} />} busy={adding} disabled={full} title={full ? `Đã đủ ${data?.maxAccounts} tài khoản` : undefined} onClick={add}>
            Thêm tài khoản
          </Button>
        }
      />
      <Loadable state={list}>
        {() => (
          <ul className="card zalo-accounts" aria-label="Tài khoản Zalo (kéo để sắp xếp)">
            {accounts.map((a, i) => {
              const pill = phasePill(a);
              return (
                <li
                  key={a.id}
                  className={cx('zalo-account-row', drag === a.id && 'is-dragging', over === a.id && drag !== a.id && 'is-over', !a.enabled && 'is-disabled')}
                  draggable
                  onDragStart={(e) => {
                    setDrag(a.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    setOver(a.id);
                  }}
                  onDragLeave={() => setOver((o) => (o === a.id ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(a.id);
                    setDrag(null);
                    setOver(null);
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                >
                  <span className="drag-handle" title="Kéo để sắp xếp" aria-hidden="true">
                    <GripVertical size={16} />
                  </span>
                  <span className="order-buttons">
                    <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Lên" disabled={i === 0} onClick={() => move(a.id, -1)}>
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" className="btn btn-ghost btn-icon btn-xs" aria-label="Xuống" disabled={i === accounts.length - 1} onClick={() => move(a.id, 1)}>
                      <ChevronDown size={14} />
                    </button>
                  </span>
                  <a className="zalo-account-main" href={`#/zalo/${encodeURIComponent(a.id)}`}>
                    <span className="zalo-account-avatar">
                      <Avatar name={accountName(a)} src={a.avatar} size={40} />
                      {a.badge > 0 && <span className="unread-badge nums">{a.badge > 99 ? '99+' : a.badge}</span>}
                    </span>
                    <span className="cell-text">
                      <span className="truncate">
                        <strong>{accountName(a)}</strong>
                        {a.active && <span className="secondary small"> · đang mở trên máy chủ</span>}
                      </span>
                      <span className="secondary small truncate">
                        {a.label && a.name && a.label !== a.name ? `${a.name} · ` : ''}
                        {a.uid ? <span className="mono">uid {a.uid}</span> : 'Chưa đăng nhập'}
                        {a.id === 'default' && ' · tài khoản chính'}
                      </span>
                    </span>
                  </a>
                  <Badge tone={pill.tone} dot>
                    {pill.label}
                  </Badge>
                  <input
                    type="checkbox"
                    className="switch"
                    checked={a.enabled}
                    onChange={(e) => setEnabled(a, e.target.checked)}
                    aria-label={a.enabled ? `Tắt ${accountName(a)}` : `Bật ${accountName(a)}`}
                    title={a.enabled ? 'Đang bật' : 'Đang tắt'}
                  />
                  <RowMenu
                    items={[
                      { label: phaseKind(a.phase) === 'ready' ? 'Mở' : 'Đăng nhập bằng mã QR', icon: <QrCode size={15} />, onSelect: () => navigate(`/zalo/${encodeURIComponent(a.id)}`) },
                      { label: 'Đổi tên hiển thị', icon: <Pencil size={15} />, onSelect: () => setRenaming(a) },
                      phaseKind(a.phase) === 'ready' && { label: 'Đăng xuất Zalo', icon: <LogOut size={15} />, onSelect: () => logout(a) },
                      a.id === 'default'
                        ? { label: 'Không xoá được tài khoản chính (chỉ đăng xuất)', icon: <Trash2 size={15} />, disabled: true, onSelect: () => undefined }
                        : { label: 'Xoá tài khoản', icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(a) },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Loadable>
      {renaming && (
        <RenameAccount
          account={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function RenameAccount({ account, onClose, onDone }: { account: ZaloAccount; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState(account.label);
  return (
    <FormModal
      title="Đổi tên hiển thị"
      subtitle={account.name ? `Tên Zalo: ${account.name}` : undefined}
      onClose={onClose}
      onSubmit={async () => {
        await api.updateAccount(account.id, { label: label.trim() });
        toast('Đã đổi tên');
        onDone();
      }}
    >
      <Field label="Tên hiển thị" hint="Chỉ dùng trong Compola (trang quản trị, phân quyền, bộ chọn tài khoản). Để trống để dùng tên Zalo.">
        <input className="input" autoFocus value={label} placeholder={account.name || 'vd. Kho Hà Nội'} onChange={(e) => setLabel(e.target.value)} />
      </Field>
    </FormModal>
  );
}

// ---- One account: sign-in (QR) / status / sign-out ----

function AccountDetail({ id }: { id: string }) {
  // GET /api/admin/accounts/<id>; a server without M5 only has /api/admin/zalo (= "default").
  const status = useLoad<ZaloStatus & { summary?: ZaloAccount }>(
    () =>
      api.account(id).then(
        (d) => ({ phase: d.phase, account: { name: accountName(d.account), avatar: d.account.avatar, phase: phaseKind(d.account.phase) }, summary: d.account }),
        (e) => {
          if (id === 'default' && e instanceof ApiError && e.status === 404) return api.zalo();
          throw e;
        },
      ),
    [id],
  );
  useInterval(() => void status.reload(), 2000);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await status.reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    const name = status.data?.account?.name;
    const ok = await confirmDialog({
      title: `Đăng xuất ${name ? `“${name}”` : 'tài khoản Zalo'} khỏi máy chủ?`,
      message:
        'Mọi người dùng Compola Server sẽ mất kết nối tới tài khoản này cho tới khi đăng nhập lại. Để đăng nhập lại, quét mã QR ở trang này bằng Zalo trên điện thoại.',
      confirmLabel: 'Đăng xuất Zalo',
      danger: true,
    });
    if (!ok) return;
    await act(async () => {
      await api.accountLogout(id).catch((e) => (id === 'default' && e instanceof ApiError && e.status === 404 ? api.zaloLogout() : Promise.reject(e)));
      toast('Đã đăng xuất Zalo');
    });
  };
  const qr = () => api.accountQr(id).catch((e) => (id === 'default' && e instanceof ApiError && e.status === 404 ? api.zaloQr() : Promise.reject(e)));

  const data = status.data;
  const summary = data?.summary;
  return (
    <div className="page page-narrow">
      <a className="back-link" href="#/zalo">
        <ArrowLeft size={15} /> Tài khoản Zalo
      </a>
      <PageHeader
        title={summary ? accountName(summary) : data?.account?.name || 'Tài khoản Zalo'}
        subtitle={summary?.uid ? `uid ${summary.uid}${summary.id === 'default' ? ' · tài khoản chính' : ''}` : id === 'default' ? 'Tài khoản chính của máy chủ' : `Mã tài khoản ${id}`}
      />
      {status.error && !data ? (
        <ErrorBox message={status.error instanceof Error ? status.error.message : String(status.error)} onRetry={status.reload} />
      ) : !data ? (
        <Spinner label="Đang tải…" />
      ) : (
        <>
          {status.error ? <ErrorBox message={`Mất kết nối tới máy chủ: ${status.error instanceof Error ? status.error.message : ''}`} /> : null}
          {summary && !summary.enabled && <div className="notice notice-warn"><span>Tài khoản đang tắt: người dùng Compola Server chưa dùng được tài khoản này.</span></div>}
          <ZaloCard status={data} busy={busy} onQr={() => act(qr)} onRetry={() => act(api.zaloRetry)} onLogout={logout} />
        </>
      )}
    </div>
  );
}

function ZaloCard({ status, busy, onQr, onRetry, onLogout }: { status: ZaloStatus; busy: boolean; onQr: () => void; onRetry: () => void; onLogout: () => void }) {
  const phase: ZaloPhase = status.phase ?? { kind: 'starting' };
  switch (phase.kind) {
    case 'ready':
      return (
        <section className="card zalo-card">
          <div className="zalo-ready">
            <Avatar name={status.account?.name || 'Zalo'} src={status.account?.avatar} size={72} />
            <div className="zalo-ready-text">
              <h2>{status.account?.name || 'Tài khoản Zalo'}</h2>
              <Badge tone="ok" dot>
                Đã đăng nhập
              </Badge>
              <p className="secondary small">Người dùng Compola Server dùng tài khoản này theo quyền được cấp ở mục Phân quyền.</p>
            </div>
          </div>
          <div className="zalo-foot">
            <Button variant="danger-ghost" icon={<LogOut size={16} />} busy={busy} onClick={onLogout}>
              Đăng xuất Zalo
            </Button>
          </div>
        </section>
      );
    case 'login':
      return (
        <section className="card zalo-card">
          <div className="zalo-lead">Đăng nhập tài khoản Zalo để kết nối với Compola</div>
          <QrBody state={phase.login} notice={phase.notice ?? null} busy={busy} refresh={onQr} />
          <div className="login-trust">
            <Lock size={12} />
            <span>Tin nhắn đi thẳng tới máy chủ Zalo, không qua máy chủ nào khác.</span>
          </div>
        </section>
      );
    case 'preparing':
      return (
        <section className="card zalo-card">
          <RuntimeSetupBody setup={phase.setup} busy={busy} onRetry={onRetry} />
        </section>
      );
    case 'signingIn':
      return (
        <section className="card zalo-card zalo-wait">
          <Spinner />
          <h2>Đang đăng nhập…</h2>
          <p className="secondary">Đang tải dữ liệu từ Zalo. Việc này có thể mất một lúc.</p>
        </section>
      );
    default:
      return (
        <section className="card zalo-card zalo-wait">
          <Spinner />
          <h2>Đang khởi động…</h2>
          <p className="secondary">Máy chủ đang mở phần lõi Zalo PC.</p>
        </section>
      );
  }
}

// ---- QR sign-in (wording from LoginView) ----

function QrBody({ state, notice, busy, refresh }: { state: LoginState; notice: string | null; busy: boolean; refresh: () => void }) {
  const step = state.step;
  return (
    <div className="login-body">
      {notice && (
        <div className="notice notice-warn">
          <AlertTriangle size={16} />
          <span>{notice}</span>
        </div>
      )}
      {state.isSecondQr && step.kind === 'waitingScan' && (
        <div className="notice">
          <Info size={16} />
          <span>
            <b>Bước 2/2.</b> Đã quét lần 1. Tài khoản của bạn cần quét thêm mã mới này để xác nhận thiết bị.
          </span>
        </div>
      )}
      <div className={cx('login-qr-box', (step.kind === 'waitingConfirm' || step.kind === 'failed') && 'is-panel')}>
        <QrArea state={state} busy={busy} onRefresh={refresh} />
      </div>
      {step.kind === 'waitingConfirm' ? (
        <div className="login-caption">
          Chưa thấy yêu cầu trên điện thoại?{' '}
          <button type="button" className="link" onClick={refresh} disabled={busy}>
            Dùng mã QR khác
          </button>
        </div>
      ) : step.kind === 'failed' ? (
        <div className="login-caption is-error">{step.message}</div>
      ) : (
        <>
          <div className={cx('login-caption', step.kind === 'expired' && 'is-muted')}>
            {step.kind === 'expired' ? 'Lấy mã mới rồi quét lại bằng Zalo trên điện thoại.' : 'Chỉ dùng để đăng nhập Compola trên máy tính'}
          </div>
          <ol className="login-steps">
            <li>
              <span>
                Mở <b>Zalo</b> trên điện thoại
              </span>
            </li>
            <li>
              <span>
                Nhấn biểu tượng <b>QR</b> ở thanh tìm kiếm
              </span>
            </li>
            <li>
              <span>
                Quét mã và <b>xác nhận đăng nhập</b>
              </span>
            </li>
          </ol>
        </>
      )}
    </div>
  );
}

function QrArea({ state, busy, onRefresh }: { state: LoginState; busy: boolean; onRefresh: () => void }) {
  const step = state.step;
  if (step.kind === 'waitingConfirm') {
    return (
      <div className="login-confirm">
        <span className="login-confirm-avatar">
          <Avatar name={step.name} src={step.avatar} size={76} />
          <span className="login-confirm-badge">
            <Smartphone size={13} strokeWidth={2.4} />
          </span>
        </span>
        <div className="login-confirm-name">{step.name}</div>
        <div className="login-waiting">
          <Spin />
          <span>Xác nhận đăng nhập trên điện thoại</span>
        </div>
      </div>
    );
  }
  if (step.kind === 'failed') {
    return (
      <div className="login-confirm">
        <span className="login-fail-icon">
          <AlertTriangle size={24} />
        </span>
        <div className="login-confirm-name">Chưa lấy được mã QR</div>
        <Button variant="primary" icon={<RefreshCw size={14} />} busy={busy} onClick={onRefresh}>
          Thử lại
        </Button>
      </div>
    );
  }
  const expired = step.kind === 'expired';
  return (
    <div className="login-qr">
      {state.qr && step.kind !== 'generating' ? <img src={state.qr} alt="Mã QR đăng nhập Zalo" draggable={false} className={cx('login-qr-code', expired && 'is-expired')} /> : <Spin size={22} />}
      {expired && (
        <div className="login-expired">
          <span className="login-expired-title">Mã QR đã hết hạn</span>
          <Button variant="primary" icon={<RefreshCw size={14} />} busy={busy} onClick={onRefresh} autoFocus>
            Lấy mã mới
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Runtime setup (wording from RuntimeSetupView) ----

const STEPS: { key: RuntimeSetup['step']; title: string; icon: LucideIcon }[] = [
  { key: 'looking', title: 'Tìm bản Zalo PC mới nhất', icon: Search },
  { key: 'downloading', title: 'Tải phần lõi Zalo PC', icon: Download },
  { key: 'verifying', title: 'Kiểm tra chữ ký số của VNG', icon: ShieldCheck },
  { key: 'installing', title: 'Cài đặt', icon: PackageCheck },
];

function RuntimeSetupBody({ setup, busy, onRetry }: { setup: RuntimeSetup; busy: boolean; onRetry: () => void }) {
  const current = Math.max(0, STEPS.findIndex((s) => s.key === setup.step));
  return (
    <div className="runtime">
      <div className="zalo-lead">Chuẩn bị Compola cho lần đầu sử dụng</div>
      <p className="secondary small">
        Máy chủ tải phần lõi chính thức của Zalo PC từ máy chủ của VNG (khoảng 340 MB) và kiểm tra chữ ký số của VNG. Không cần cài
        Zalo PC.
      </p>
      <ol className="runtime-steps">
        {STEPS.map((s, i) => {
          const state = i < current ? 'done' : i > current ? 'waiting' : setup.failure ? 'failed' : 'running';
          const Icon = s.icon;
          const downloading = state === 'running' && s.key === 'downloading';
          const received = setup.received ?? 0;
          return (
            <li key={s.key} className={`runtime-step is-${state}`}>
              <span className="runtime-step-mark">
                {state === 'done' ? <Check size={13} strokeWidth={3} /> : state === 'running' ? <Spin /> : state === 'failed' ? <X size={13} strokeWidth={3} /> : <Icon size={13} />}
              </span>
              <span className="runtime-step-body">
                <span className="runtime-step-title">
                  <span>{s.title}</span>
                  {downloading && setup.total ? <span className="nums secondary">{Math.round((received / setup.total) * 100)}%</span> : null}
                </span>
                {downloading && (
                  <>
                    {setup.total ? <progress className="runtime-bar" value={received} max={setup.total} /> : null}
                    <span className="secondary small nums">{setup.total ? `${formatBytes(received)} / ${formatBytes(setup.total)}` : formatBytes(received)}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {setup.failure && (
        <>
          <ErrorBox message={setup.failure} />
          <div>
            <Button variant="primary" icon={<RefreshCw size={14} />} busy={busy} onClick={onRetry} autoFocus>
              Thử lại
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

const Spin = ({ size = 13 }: { size?: number }) => <Loader2 className="spin" size={size} />;
