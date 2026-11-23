import { useState } from 'react';
import { ArrowLeftRight, CheckCircle2, MonitorSmartphone, XCircle } from 'lucide-react';
import { api, ApiError } from '../api';
import { formatDateTime, roleLabel, shortId } from '../format';
import { topRole } from '../access';
import { AccessByAccount } from '../accountsView';
import { useMyAccounts } from './Me';
import { useLoad } from '../hooks';
import { navigate, type Route } from '../router';
import type { DeviceInfo, Me } from '../types';
import { Badge, BrandMark, Button, DeviceLabel, ErrorBox, Field, Person, Spinner } from '../ui';

function normalizeCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : raw.trim().toUpperCase();
}

export function DevicePage({ route, me }: { route: Route; me: Me }) {
  const code = route.query.get('code');
  return <div className="narrow">{code ? <Approve code={normalizeCode(code)} me={me} /> : <EnterCode />}</div>;
}

function EnterCode() {
  const [value, setValue] = useState('');
  return (
    <div className="card card-body device-card">
      <div className="device-icon">
        <MonitorSmartphone size={30} />
      </div>
      <h2>Đăng nhập thiết bị</h2>
      <p className="secondary">Nhập mã hiển thị trong ứng dụng Compola trên thiết bị của bạn.</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) navigate(`/device?code=${encodeURIComponent(normalizeCode(value))}`);
        }}
      >
        <Field label="Mã thiết bị">
          <input className="input input-code nums" placeholder="ABCD-EFGH" autoFocus autoCapitalize="characters" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="btn-block" disabled={!value.trim()}>
          Tiếp tục
        </Button>
      </form>
    </div>
  );
}

function Approve({ code, me }: { code: string; me: Me }) {
  // The pending request: which device asks (name, id, IP). 404 = wrong or expired code; other failures fall back
  // to showing only the code.
  const info = useLoad<DeviceInfo | null>(
    () =>
      api.deviceInfo(code).catch((e) => {
        if (e instanceof ApiError && e.status === 404) throw e;
        return null;
      }),
    [code],
  );
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);
  const canUse = !!topRole(me);
  const accounts = useMyAccounts(me);

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    setError(null);
    try {
      await api.deviceApprove(code, approve);
      setDone(approve ? 'approved' : 'denied');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className="card card-body device-card">
        <div className={done === 'approved' ? 'device-icon is-ok' : 'device-icon is-danger'}>
          {done === 'approved' ? <CheckCircle2 size={32} /> : <XCircle size={32} />}
        </div>
        <h2>{done === 'approved' ? 'Đã cho phép thiết bị' : 'Đã từ chối thiết bị'}</h2>
        <p className="secondary">
          {done === 'approved'
            ? `${info.data ? `Thiết bị “${info.data.deviceName}” #${shortId(info.data.deviceId)}` : 'Thiết bị'} sẽ đăng nhập bằng tài khoản @${me.user.username} trong giây lát. Bạn có thể đóng trang này.`
            : 'Thiết bị sẽ không được đăng nhập. Bạn có thể đóng trang này.'}
        </p>
      </div>
    );
  }

  return (
    <div className="card card-body device-card">
      {/* Two-logo header: this server ⇄ the device asking (incident.io "Sign in with Slack"). */}
      <div className="link-logos" aria-hidden="true">
        <BrandMark large />
        <ArrowLeftRight size={18} className="tertiary" />
        <span className="link-logo-device">
          <MonitorSmartphone size={22} />
        </span>
      </div>
      {info.loading && info.data === undefined && !info.error ? (
        <Spinner />
      ) : info.error ? (
        <>
          <h2>Không dùng được mã {code}</h2>
          <ErrorBox message={info.error instanceof Error ? info.error.message : String(info.error)} />
          <p className="secondary">Mã có thể đã hết hạn (10 phút) hoặc đã được xử lý. Hãy bắt đầu đăng nhập lại từ ứng dụng Compola.</p>
        </>
      ) : (
        <>
          <h2>Cho phép thiết bị này đăng nhập bằng tài khoản của bạn?</h2>
          <CodeBoxes code={code} />
          <p className="secondary">Chỉ cho phép khi mã này trùng với mã đang hiển thị trên thiết bị.</p>
          <div className="identity-block">
            <span className="identity-label">Thiết bị yêu cầu</span>
            {info.data ? (
              <>
                <DeviceLabel kind="device" deviceName={info.data.deviceName} deviceId={info.data.deviceId} sub="Ứng dụng Compola" />
                <div className="device-meta">
                  <span>
                    IP <span className="mono">{info.data.ip || '—'}</span>
                  </span>
                  <span>Yêu cầu lúc {formatDateTime(info.data.createdAt)}</span>
                </div>
              </>
            ) : (
              <span className="secondary small">Không lấy được thông tin thiết bị; chỉ có mã ở trên.</span>
            )}
          </div>
          <div className="identity-block">
            <span className="identity-label">Đăng nhập với tư cách</span>
            <Person user={me.user} source={me.user.source} />
            {me.user.isAdmin ? (
              <div>
                <Badge tone="accent">{roleLabel('admin')}</Badge> <span className="secondary small">· mọi tài khoản Zalo</span>
              </div>
            ) : (
              <AccessByAccount access={me.access} accounts={accounts} empty={<Badge tone="warn">{roleLabel(null)}</Badge>} />
            )}
          </div>
          {!canUse && (
            <ErrorBox message="Tài khoản của bạn chưa được cấp quyền dùng Compola trên máy chủ này. Hãy nhờ quản trị viên cấp quyền trước." />
          )}
          {error && <ErrorBox message={error} />}
          <div className="device-actions">
            <Button variant="secondary" busy={busy === 'deny'} disabled={!!busy} onClick={() => decide(false)}>
              Từ chối
            </Button>
            <Button variant="primary" busy={busy === 'approve'} disabled={!!busy || !canUse} onClick={() => decide(true)}>
              Cho phép
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** The user code as big segmented boxes: XXXX – XXXX. */
function CodeBoxes({ code }: { code: string }) {
  const [a, b] = code.includes('-') ? code.split('-') : [code.slice(0, 4), code.slice(4)];
  const boxes = (part: string) =>
    part.split('').map((ch, i) => (
      <span key={i} className="code-box">
        {ch}
      </span>
    ));
  return (
    <div className="code-boxes nums" aria-label={`Mã ${code}`}>
      {boxes(a)}
      <span className="code-dash">–</span>
      {boxes(b ?? '')}
    </div>
  );
}
