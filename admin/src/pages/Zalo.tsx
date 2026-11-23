// Tài khoản Zalo: the host's Zalo account, so an admin can sign the host in and out from the console (the host can
// run headless). GET /api/admin/zalo is polled every 2 s while the page is open. The QR card copies the desktop app's
// LoginView (src/features/setup/LoginView.tsx) and the runtime checklist its RuntimeSetupView, so both read the same.
import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Download, Info, Lock, LogOut, PackageCheck, RefreshCw, Search, ShieldCheck, Smartphone, X, type LucideIcon } from 'lucide-react';
import { api } from '../api';
import { formatBytes } from '../format';
import { useInterval, useLoad } from '../hooks';
import { confirmDialog, toast, toastError } from '../store';
import type { LoginState, RuntimeSetup, ZaloPhase, ZaloStatus } from '../types';
import { Avatar, Badge, Button, cx, ErrorBox, PageHeader, Spinner } from '../ui';

export function ZaloPage() {
  const status = useLoad(() => api.zalo(), []);
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
      await api.zaloLogout();
      toast('Đã đăng xuất Zalo');
    });
  };

  const data = status.data;
  return (
    <div className="page page-narrow">
      <PageHeader title="Tài khoản Zalo" subtitle="Tài khoản Zalo mà máy chủ dùng chung cho mọi người dùng Compola Server" />
      {status.error && !data ? (
        <ErrorBox message={status.error instanceof Error ? status.error.message : String(status.error)} onRetry={status.reload} />
      ) : !data ? (
        <Spinner label="Đang tải…" />
      ) : (
        <>
          {status.error ? <ErrorBox message={`Mất kết nối tới máy chủ: ${status.error instanceof Error ? status.error.message : ''}`} /> : null}
          <ZaloCard status={data} busy={busy} onQr={() => act(api.zaloQr)} onRetry={() => act(api.zaloRetry)} onLogout={logout} />
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
