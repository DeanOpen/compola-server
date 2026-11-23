// Sign-in: a centred column (Notion login): the username first, then "Tiếp tục" asks for the password; below,
// "hoặc tiếp tục với" and one tile per SSO provider and per LDAP directory. With only one or two alternatives they
// are full-width "Tiếp tục với …" buttons instead (Calendly).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Fingerprint, KeyRound, MonitorSmartphone, Server } from 'lucide-react';
import { api, isMock } from '../api';
import { useLoad } from '../hooks';
import { navigate, nextFrom, type Route } from '../router';
import { Button, cx, ErrorBox, Field, Spinner } from '../ui';

/** Reads an error the server put in the URL after a failed SSO round trip (`?error=` or `#/login?error=`). */
function urlError(route: Route): string | null {
  const fromHash = route.query.get('error');
  if (fromHash) return fromHash;
  try {
    return new URLSearchParams(window.location.search).get('error');
  } catch {
    return null;
  }
}

interface Alt {
  key: string;
  label: string;
  sub: string;
  icon: React.ReactNode;
  onSelect: () => void;
  active?: boolean;
}

export function SignInPage({ route, signedIn, onSignedIn }: { route: Route; signedIn: boolean; onSignedIn: () => Promise<void> }) {
  const next = nextFrom(route);
  const providers = useLoad(() => api.providers(), []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'username' | 'password'>('username');
  const [method, setMethod] = useState<string | null>(null); // "local" or an LDAP provider id
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => urlError(route));
  const passwordRef = useRef<HTMLInputElement>(null);

  // Already signed in (e.g. came back from SSO) → continue.
  useEffect(() => {
    if (signedIn) navigate(next, true);
  }, [signedIn, next]);

  const p = providers.data;
  useEffect(() => {
    if (p && method === null) setMethod(p.local ? 'local' : p.ldap[0]?.id ?? null);
  }, [p, method]);
  useEffect(() => {
    if (step === 'password') passwordRef.current?.focus();
  }, [step]);

  const deviceCode = next.startsWith('/device') ? new URLSearchParams(next.split('?')[1] ?? '').get('code') ?? undefined : undefined;
  const methodName = method === 'local' ? 'Tài khoản nội bộ' : p?.ldap.find((l) => l.id === method)?.name ?? '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (step === 'username') {
      if (!username.trim()) return setError('Nhập tên đăng nhập.');
      setStep('password');
      return;
    }
    if (!password || !method) return setError('Nhập mật khẩu.');
    setBusy(true);
    try {
      await api.login(username.trim(), password, method);
      await onSignedIn();
      navigate(next, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const sso = async (id: string) => {
    setError(null);
    if (isMock) {
      try {
        await api.mockOidc(id);
        await onSignedIn();
        navigate(next, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    window.location.href = api.oidcStartUrl(id, `/admin/#${next}`, deviceCode);
  };

  const pickPasswordMethod = (id: string) => {
    setMethod(id);
    setError(null);
    if (username.trim()) setStep('password');
  };

  const alts: Alt[] = p
    ? [
        ...p.oidc.map((o) => ({ key: `oidc:${o.id}`, label: o.name, sub: 'SSO', icon: <Fingerprint size={18} />, onSelect: () => sso(o.id) })),
        ...p.ldap
          .filter((l) => l.id !== method)
          .map((l) => ({ key: `ldap:${l.id}`, label: l.name, sub: 'LDAP · mật khẩu công ty', icon: <Server size={18} />, onSelect: () => pickPasswordMethod(l.id) })),
        ...(p.local && method !== 'local' ? [{ key: 'local', label: 'Tài khoản nội bộ', sub: 'Mật khẩu của máy chủ này', icon: <KeyRound size={18} />, onSelect: () => pickPasswordMethod('local') }] : []),
      ]
    : [];

  return (
    <div className="center-screen signin-screen">
      <div className="signin">
        <div className="signin-brand">
          <span className="brand-mark brand-mark-lg">C</span>
          <h1>Đăng nhập vào {p?.serverName || 'Compola Server'}</h1>
          <p className="secondary">Máy chủ Compola dùng chung tài khoản Zalo của nhóm bạn</p>
        </div>

        {deviceCode && (
          <div className="notice">
            <MonitorSmartphone size={18} />
            <span>
              Đăng nhập để cho phép thiết bị có mã <strong className="nums">{deviceCode}</strong>.
            </span>
          </div>
        )}

        {providers.error && !p ? (
          <ErrorBox message={providers.error instanceof Error ? providers.error.message : String(providers.error)} onRetry={providers.reload} />
        ) : !p ? (
          <Spinner />
        ) : (
          <>
            {method && (
              <form className="form" onSubmit={submit} noValidate>
                {step === 'username' ? (
                  <Field label="Tên đăng nhập" hint={methodName !== 'Tài khoản nội bộ' ? `Đăng nhập bằng ${methodName}` : undefined}>
                    <input
                      className="input"
                      autoFocus
                      autoComplete="username"
                      autoCapitalize="off"
                      spellCheck={false}
                      placeholder="vd. lan hoặc lan.tran"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </Field>
                ) : (
                  <>
                    <div className="signin-who">
                      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Đổi tên đăng nhập" onClick={() => setStep('username')}>
                        <ArrowLeft size={16} />
                      </button>
                      <span className="cell-text">
                        <strong className="truncate">@{username.trim()}</strong>
                        <span className="secondary small">{methodName}</span>
                      </span>
                    </div>
                    {/* Keeps the username in the form for password managers. */}
                    <input type="text" autoComplete="username" value={username} readOnly hidden />
                    <Field label="Mật khẩu">
                      <input ref={passwordRef} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </Field>
                  </>
                )}
                {error && <ErrorBox message={error} />}
                <Button type="submit" variant="primary" className="btn-block" busy={busy}>
                  {step === 'username' ? 'Tiếp tục' : 'Đăng nhập'}
                </Button>
              </form>
            )}
            {alts.length > 0 && (
              <>
                {method && <div className="divider">hoặc tiếp tục với</div>}
                {alts.length <= 2 ? (
                  <div className="sso-list">
                    {alts.map((a) => (
                      <Button key={a.key} className="btn-block btn-lg" icon={a.icon} onClick={a.onSelect}>
                        Tiếp tục với {a.label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="provider-tiles">
                    {alts.map((a) => (
                      <button key={a.key} type="button" className={cx('provider-tile', a.active && 'is-active')} onClick={a.onSelect}>
                        <span className="provider-tile-icon">{a.icon}</span>
                        <span className="cell-text">
                          <span className="truncate">{a.label}</span>
                          <span className="secondary small truncate">{a.sub}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {!method && error && <ErrorBox message={error} />}
            {!method && !alts.length && <ErrorBox message="Máy chủ chưa bật cách đăng nhập nào." />}
          </>
        )}
        {isMock && (
          <p className="field-hint center">
            Mock: <code>admin</code> (quản trị), <code>lan</code> (nội bộ) hoặc <code>minh</code> (LDAP), mật khẩu bất kỳ.
          </p>
        )}
      </div>
    </div>
  );
}
