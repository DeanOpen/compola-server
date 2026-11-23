import { useState, type ReactNode } from 'react';
import { CheckCircle2, Fingerprint, FlaskConical, KeyRound, Plus, Server, Trash2, XCircle } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { confirmDialog, toast, toastError } from '../store';
import type { LdapConfig, OidcConfig, Provider, ProviderKind, ProviderTestResult } from '../types';
import { Button, CopyField, ErrorBox, Field, FormModal, Loadable, Modal, PageHeader, PasswordInput, RowMenu, Segmented, StatusPill, Toggle } from '../ui';

/** What the server sends back for a stored secret; sending it back keeps the stored value. */
const SECRET_SET = '••••';

const LDAP_DEFAULTS: LdapConfig = {
  url: 'ldaps://',
  startTls: false,
  bindDn: '',
  bindPassword: '',
  userBaseDn: '',
  userFilter: '(uid={username})',
  usernameAttr: 'uid',
  displayNameAttr: 'cn',
  emailAttr: 'mail',
  groupBaseDn: '',
  groupFilter: '(member={dn})',
  groupNameAttr: 'cn',
  adminGroup: '',
  autoCreate: true,
};

const OIDC_DEFAULTS: OidcConfig = {
  issuer: '',
  authorizationUrl: '',
  tokenUrl: '',
  userinfoUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
  displayNameClaim: 'name',
  emailClaim: 'email',
  groupsClaim: '',
  adminGroup: '',
  autoCreate: true,
};

interface Preset {
  label: string;
  name: string;
  config: Partial<OidcConfig>;
  manual?: boolean;
  hint?: string;
}

const OIDC_PRESETS: Preset[] = [
  { label: 'Google', name: 'Google', config: { issuer: 'https://accounts.google.com', scopes: 'openid profile email', usernameClaim: 'email' } },
  {
    label: 'Microsoft Entra ID',
    name: 'Microsoft',
    config: { issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', scopes: 'openid profile email', usernameClaim: 'preferred_username', groupsClaim: 'groups' },
    hint: 'Thay <tenant-id> bằng mã tenant của bạn.',
  },
  {
    label: 'Keycloak',
    name: 'Keycloak',
    config: { issuer: 'https://<host>/realms/<realm>', scopes: 'openid profile email', usernameClaim: 'preferred_username', groupsClaim: 'groups' },
  },
  {
    label: 'GitHub (OAuth 2)',
    name: 'GitHub',
    manual: true,
    config: {
      issuer: '',
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userinfoUrl: 'https://api.github.com/user',
      scopes: 'read:user user:email',
      usernameClaim: 'login',
      displayNameClaim: 'name',
      emailClaim: 'email',
    },
  },
];

function callbackUrl(publicUrl: string) {
  return `${publicUrl.replace(/\/+$/, '')}/api/auth/oidc/callback`;
}

export function ProvidersPage() {
  const providers = useLoad(() => api.adminProviders(), []);
  const server = useLoad(() => api.server(), []);
  const [editing, setEditing] = useState<Provider | ProviderKind | null>(null);
  const [testing, setTesting] = useState<Provider | null>(null);
  const publicUrl = server.data?.publicUrl ?? '';

  const toggle = async (p: Provider) => {
    try {
      await api.updateProvider(p.id, { enabled: !p.enabled });
      toast(p.enabled ? 'Đã tắt' : 'Đã bật');
      void providers.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async (p: Provider) => {
    const ok = await confirmDialog({
      title: `Xóa “${p.name}”?`,
      message: 'Người dùng của nguồn này sẽ không đăng nhập được nữa (tài khoản và quyền của họ vẫn được giữ).',
      confirmLabel: 'Xóa',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteProvider(p.id);
      toast('Đã xóa');
      void providers.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const list = providers.data ?? [];
  const section = (kind: ProviderKind) => list.filter((p) => p.kind === kind);

  // One section per sign-in method (Plane "Identity", incident.io "Security"): a header row with the protocol, a
  // one-line description, its status and a Configure/Add button; each configured provider below it with a status
  // pill, an enable toggle and "Cấu hình" (the form opens in a side sheet).
  return (
    <div className="page page-narrow">
      <PageHeader title="Đăng nhập" subtitle="Những cách người dùng đăng nhập vào máy chủ Compola (trang quản trị và ứng dụng Compola)" />

      <section className="card method-card">
        <div className="method-head">
          <span className="method-logo">
            <KeyRound size={20} />
          </span>
          <div className="method-text">
            <div className="method-title">
              Đăng nhập bằng mật khẩu nội bộ <StatusPill on />
            </div>
            <p className="secondary small">Tên đăng nhập và mật khẩu lưu trên máy chủ này, quản lý ở Người dùng & nhóm. Luôn bật để quản trị viên không bị khóa ngoài.</p>
          </div>
          <input type="checkbox" className="switch" checked disabled aria-label="Luôn bật" />
        </div>
      </section>

      <Loadable state={providers}>
        {() => (
          <>
            <MethodSection
              kind="ldap"
              title="LDAP / Active Directory"
              description="Người dùng đăng nhập bằng tài khoản công ty; nhóm LDAP có thể được đồng bộ để cấp quyền theo nhóm."
              providers={section('ldap')}
              onAdd={() => setEditing('ldap')}
              onEdit={setEditing}
              onTest={setTesting}
              onToggle={toggle}
              onRemove={remove}
            />
            <MethodSection
              kind="oidc"
              title="SSO: OpenID Connect / OAuth 2"
              description="Nút “Đăng nhập với …” cho Google, Microsoft Entra ID, Keycloak, GitHub… Hoạt động cả với đăng nhập thiết bị."
              providers={section('oidc')}
              onAdd={() => setEditing('oidc')}
              onEdit={setEditing}
              onTest={setTesting}
              onToggle={toggle}
              onRemove={remove}
              footer={
                <div className="method-foot">
                  <span className="field-label">Địa chỉ chuyển hướng (Redirect URI) để đăng ký ở nhà cung cấp</span>
                  {publicUrl ? (
                    <CopyField value={callbackUrl(publicUrl)} />
                  ) : (
                    <span className="secondary small">
                      Chưa có: đặt địa chỉ công khai ở <a href="#/settings">Cài đặt máy chủ</a> trước.
                    </span>
                  )}
                </div>
              }
            />
          </>
        )}
      </Loadable>
      {editing && (
        <ProviderEditor
          provider={typeof editing === 'string' ? null : editing}
          kind={typeof editing === 'string' ? editing : editing.kind}
          publicUrl={publicUrl}
          onClose={() => setEditing(null)}
          onDone={(saved) => {
            setEditing(null);
            void providers.reload();
            if (saved) setTesting(saved);
          }}
        />
      )}
      {testing && <TestProvider provider={testing} onClose={() => setTesting(null)} />}
    </div>
  );
}

function MethodSection({
  kind,
  title,
  description,
  providers,
  onAdd,
  onEdit,
  onTest,
  onToggle,
  onRemove,
  footer,
}: {
  kind: ProviderKind;
  title: string;
  description: string;
  providers: Provider[];
  onAdd: () => void;
  onEdit: (p: Provider) => void;
  onTest: (p: Provider) => void;
  onToggle: (p: Provider) => void;
  onRemove: (p: Provider) => void;
  footer?: ReactNode;
}) {
  const enabled = providers.filter((p) => p.enabled).length;
  return (
    <section className="card method-card">
      <div className="method-head">
        <span className="method-logo">{kind === 'ldap' ? <Server size={20} /> : <Fingerprint size={20} />}</span>
        <div className="method-text">
          <div className="method-title">
            {title} <StatusPill on={enabled > 0} onLabel={providers.length > 1 ? `${enabled} đang bật` : 'Đang bật'} offLabel={providers.length ? 'Đã tắt' : 'Chưa cấu hình'} />
          </div>
          <p className="secondary small">{description}</p>
        </div>
        <Button size="sm" icon={<Plus size={15} />} onClick={onAdd}>
          {providers.length ? 'Thêm' : 'Cấu hình'}
        </Button>
      </div>
      {providers.length > 0 && (
        <ul className="list method-list">
          {providers.map((p) => (
            <li key={p.id} className="list-row">
              <span className="list-main">
                <span className="truncate">
                  <strong>{p.name}</strong>{' '}
                  <span className="secondary small">{p.kind === 'ldap' ? 'LDAP' : p.config.issuer ? 'OpenID Connect' : 'OAuth 2'}</span>
                </span>
                <span className="secondary small truncate">
                  {p.kind === 'ldap' ? p.config.url : p.config.issuer || p.config.authorizationUrl}
                  {p.config.autoCreate ? ' · tự tạo người dùng' : ' · chỉ người dùng đã tạo trước'}
                </span>
              </span>
              <StatusPill on={p.enabled} />
              <input type="checkbox" className="switch" checked={p.enabled} onChange={() => onToggle(p)} aria-label={p.enabled ? `Tắt ${p.name}` : `Bật ${p.name}`} />
              <Button size="sm" onClick={() => onEdit(p)}>
                Cấu hình
              </Button>
              <RowMenu
                items={[
                  { label: 'Kiểm tra kết nối', icon: <FlaskConical size={15} />, onSelect: () => onTest(p) },
                  { label: 'Xóa', icon: <Trash2 size={15} />, danger: true, onSelect: () => onRemove(p) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {footer}
    </section>
  );
}

function text(v: string | undefined) {
  return v ?? '';
}

function ProviderEditor({
  provider,
  kind,
  publicUrl,
  onClose,
  onDone,
}: {
  provider: Provider | null;
  kind: ProviderKind;
  publicUrl: string;
  onClose: () => void;
  onDone: (testAfter: Provider | null) => void;
}) {
  const [name, setName] = useState(provider?.name ?? (kind === 'ldap' ? 'LDAP' : ''));
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [ldap, setLdap] = useState<LdapConfig>(() => ({ ...LDAP_DEFAULTS, ...(provider?.kind === 'ldap' ? provider.config : {}) }));
  const [oidc, setOidc] = useState<OidcConfig>(() => ({ ...OIDC_DEFAULTS, ...(provider?.kind === 'oidc' ? provider.config : {}) }));
  const [mode, setMode] = useState<'discovery' | 'manual'>(provider?.kind === 'oidc' && !provider.config.issuer && provider.config.authorizationUrl ? 'manual' : 'discovery');
  const [presetHint, setPresetHint] = useState<string | null>(null);
  // Secrets: the server returns "••••" when one is stored; an empty field keeps it.
  const secretWasSet = provider ? (provider.kind === 'ldap' ? provider.config.bindPassword === SECRET_SET : provider.config.clientSecret === SECRET_SET) : false;
  const [secret, setSecret] = useState('');
  const [testAfter, setTestAfter] = useState(!provider);

  const setL = <K extends keyof LdapConfig>(k: K, v: LdapConfig[K]) => setLdap((c) => ({ ...c, [k]: v }));
  const setO = <K extends keyof OidcConfig>(k: K, v: OidcConfig[K]) => setOidc((c) => ({ ...c, [k]: v }));

  const applyPreset = (p: Preset) => {
    setOidc((c) => ({ ...c, ...OIDC_DEFAULTS, clientId: c.clientId, clientSecret: c.clientSecret, ...p.config }));
    setMode(p.manual ? 'manual' : 'discovery');
    if (!name.trim()) setName(p.name);
    setPresetHint(p.hint ?? null);
  };

  const submit = async () => {
    if (!name.trim()) throw new Error('Nhập tên hiển thị.');
    const secretValue = secret ? secret : secretWasSet ? SECRET_SET : '';
    let saved: Provider | null = null;
    if (kind === 'ldap') {
      if (!/^ldaps?:\/\/.+/.test(ldap.url.trim())) throw new Error('Địa chỉ máy chủ LDAP phải bắt đầu bằng ldap:// hoặc ldaps://');
      if (!ldap.userBaseDn.trim()) throw new Error('Nhập Base DN của người dùng.');
      if (!ldap.userFilter.includes('{username}')) throw new Error('Bộ lọc người dùng phải chứa {username}.');
      const config: LdapConfig = { ...ldap, url: ldap.url.trim(), bindPassword: secretValue };
      if (provider) await api.updateProvider(provider.id, { name: name.trim(), enabled, config });
      else saved = await api.createProvider({ kind: 'ldap', name: name.trim(), enabled, config });
    } else {
      if (!oidc.clientId.trim()) throw new Error('Nhập Client ID.');
      if (mode === 'discovery' && !/^https?:\/\/.+/.test(text(oidc.issuer).trim())) throw new Error('Nhập Issuer URL (https://…).');
      if (mode === 'manual' && (!oidc.authorizationUrl?.trim() || !oidc.tokenUrl?.trim())) throw new Error('Nhập Authorization URL và Token URL.');
      const config: OidcConfig = {
        ...oidc,
        issuer: mode === 'discovery' ? text(oidc.issuer).trim() : '',
        authorizationUrl: mode === 'manual' ? text(oidc.authorizationUrl).trim() : '',
        tokenUrl: mode === 'manual' ? text(oidc.tokenUrl).trim() : '',
        userinfoUrl: mode === 'manual' ? text(oidc.userinfoUrl).trim() : '',
        clientId: oidc.clientId.trim(),
        clientSecret: secretValue,
      };
      if (provider) await api.updateProvider(provider.id, { name: name.trim(), enabled, config });
      else saved = await api.createProvider({ kind: 'oidc', name: name.trim(), enabled, config });
    }
    toast(provider ? 'Đã lưu' : 'Đã thêm nguồn đăng nhập');
    onDone(testAfter ? saved ?? provider : null);
  };

  const secretPlaceholder = secretWasSet ? `${SECRET_SET} (đã lưu — để trống để giữ nguyên)` : '';

  return (
    <FormModal
      title={provider ? `Sửa “${provider.name}”` : kind === 'ldap' ? 'Thêm LDAP / Active Directory' : 'Thêm SSO (OpenID Connect / OAuth 2)'}
      onClose={onClose}
      onSubmit={submit}
      sheet
      extraFooter={
        <label className="check">
          <input type="checkbox" checked={testAfter} onChange={(e) => setTestAfter(e.target.checked)} /> Kiểm tra sau khi lưu
        </label>
      }
    >
      <div className="form-row">
        <Field label="Tên hiển thị" hint={kind === 'oidc' ? 'Hiện trên nút “Đăng nhập với …”.' : 'Hiện trong ô chọn cách đăng nhập.'}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="field field-end">
          <Toggle checked={enabled} onChange={setEnabled} label="Bật" />
        </div>
      </div>

      {kind === 'ldap' ? (
        <>
          <fieldset className="fieldset">
            <legend>Kết nối</legend>
            <div className="form-row">
              <Field label="Địa chỉ máy chủ" hint="ldaps://ldap.congty.vn:636 hoặc ldap://…:389">
                <input className="input mono" value={ldap.url} spellCheck={false} onChange={(e) => setL('url', e.target.value)} />
              </Field>
              <div className="field field-end">
                <Toggle checked={ldap.startTls} onChange={(v) => setL('startTls', v)} label="StartTLS" hint="Dùng với ldap://" />
              </div>
            </div>
            <div className="form-row">
              <Field label="Bind DN" hint="Tài khoản dịch vụ để tìm người dùng (để trống nếu cho phép ẩn danh).">
                <input className="input mono" value={ldap.bindDn} spellCheck={false} placeholder="cn=compola,ou=services,dc=congty,dc=vn" onChange={(e) => setL('bindDn', e.target.value)} />
              </Field>
              <Field label="Mật khẩu bind">
                <PasswordInput value={secret} onChange={setSecret} placeholder={secretPlaceholder} />
              </Field>
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Người dùng</legend>
            <div className="form-row">
              <Field label="Base DN">
                <input className="input mono" value={ldap.userBaseDn} spellCheck={false} placeholder="ou=people,dc=congty,dc=vn" onChange={(e) => setL('userBaseDn', e.target.value)} />
              </Field>
              <Field label="Bộ lọc" hint="{username} = tên người dùng nhập. AD: (sAMAccountName={username})">
                <input className="input mono" value={ldap.userFilter} spellCheck={false} onChange={(e) => setL('userFilter', e.target.value)} />
              </Field>
            </div>
            <div className="form-row form-row-3">
              <Field label="Thuộc tính tên đăng nhập">
                <input className="input mono" value={ldap.usernameAttr} spellCheck={false} onChange={(e) => setL('usernameAttr', e.target.value)} />
              </Field>
              <Field label="Thuộc tính tên hiển thị">
                <input className="input mono" value={ldap.displayNameAttr} spellCheck={false} onChange={(e) => setL('displayNameAttr', e.target.value)} />
              </Field>
              <Field label="Thuộc tính email">
                <input className="input mono" value={ldap.emailAttr} spellCheck={false} onChange={(e) => setL('emailAttr', e.target.value)} />
              </Field>
            </div>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Nhóm (không bắt buộc)</legend>
            <div className="form-row">
              <Field label="Base DN nhóm">
                <input className="input mono" value={text(ldap.groupBaseDn)} spellCheck={false} placeholder="ou=groups,dc=congty,dc=vn" onChange={(e) => setL('groupBaseDn', e.target.value)} />
              </Field>
              <Field label="Bộ lọc nhóm" hint="{dn} = DN của người dùng">
                <input className="input mono" value={text(ldap.groupFilter)} spellCheck={false} onChange={(e) => setL('groupFilter', e.target.value)} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Thuộc tính tên nhóm">
                <input className="input mono" value={text(ldap.groupNameAttr)} spellCheck={false} onChange={(e) => setL('groupNameAttr', e.target.value)} />
              </Field>
              <Field label="Nhóm quản trị" hint="Thành viên nhóm này thành quản trị viên Compola.">
                <input className="input mono" value={text(ldap.adminGroup)} spellCheck={false} onChange={(e) => setL('adminGroup', e.target.value)} />
              </Field>
            </div>
            <p className="field-hint">Khi đặt Base DN nhóm, các nhóm LDAP của người dùng được đồng bộ vào mục Nhóm mỗi lần họ đăng nhập.</p>
          </fieldset>
          <Toggle
            checked={ldap.autoCreate}
            onChange={(v) => setL('autoCreate', v)}
            label="Tự tạo người dùng khi đăng nhập lần đầu"
            hint="Tắt: chỉ những tên đăng nhập đã được tạo trước ở mục Người dùng mới đăng nhập được."
          />
        </>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Địa chỉ chuyển hướng (Redirect URI) — đăng ký ở nhà cung cấp</span>
            {publicUrl ? (
              <CopyField value={callbackUrl(publicUrl)} />
            ) : (
              <div className="notice notice-warn">
                <span>
                  Chưa đặt địa chỉ công khai của máy chủ. Đặt ở <a href="#/settings">Cài đặt máy chủ</a> trước, rồi đăng ký{' '}
                  <code>&lt;địa chỉ công khai&gt;/api/auth/oidc/callback</code>.
                </span>
              </div>
            )}
          </div>
          {!provider && (
            <div className="field">
              <span className="field-label">Mẫu có sẵn</span>
              <div className="chips">
                {OIDC_PRESETS.map((p) => (
                  <button key={p.label} type="button" className="pill" onClick={() => applyPreset(p)}>
                    {p.label}
                  </button>
                ))}
              </div>
              {presetHint && <span className="field-hint">{presetHint}</span>}
            </div>
          )}
          <fieldset className="fieldset">
            <legend>Nhà cung cấp</legend>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'discovery', label: 'OpenID Connect (tự dò)' },
                { value: 'manual', label: 'Nhập địa chỉ (OAuth 2)' },
              ]}
            />
            {mode === 'discovery' ? (
              <Field label="Issuer URL" hint="Máy chủ đọc <issuer>/.well-known/openid-configuration.">
                <input className="input mono" value={text(oidc.issuer)} spellCheck={false} placeholder="https://accounts.google.com" onChange={(e) => setO('issuer', e.target.value)} />
              </Field>
            ) : (
              <>
                <Field label="Authorization URL">
                  <input className="input mono" value={text(oidc.authorizationUrl)} spellCheck={false} onChange={(e) => setO('authorizationUrl', e.target.value)} />
                </Field>
                <div className="form-row">
                  <Field label="Token URL">
                    <input className="input mono" value={text(oidc.tokenUrl)} spellCheck={false} onChange={(e) => setO('tokenUrl', e.target.value)} />
                  </Field>
                  <Field label="Userinfo URL">
                    <input className="input mono" value={text(oidc.userinfoUrl)} spellCheck={false} onChange={(e) => setO('userinfoUrl', e.target.value)} />
                  </Field>
                </div>
              </>
            )}
            <div className="form-row">
              <Field label="Client ID">
                <input className="input mono" value={oidc.clientId} spellCheck={false} onChange={(e) => setO('clientId', e.target.value)} />
              </Field>
              <Field label="Client secret">
                <PasswordInput value={secret} onChange={setSecret} placeholder={secretPlaceholder} />
              </Field>
            </div>
            <Field label="Scopes" hint={mode === 'manual' ? 'OAuth 2 thuần (không có openid): thông tin lấy từ Userinfo URL.' : 'Cách nhau bởi dấu cách.'}>
              <input className="input mono" value={oidc.scopes} spellCheck={false} onChange={(e) => setO('scopes', e.target.value)} />
            </Field>
          </fieldset>
          <fieldset className="fieldset">
            <legend>Ánh xạ thông tin (claims)</legend>
            <div className="form-row form-row-3">
              <Field label="Tên đăng nhập" hint="preferred_username, email, login…">
                <input className="input mono" value={oidc.usernameClaim} spellCheck={false} onChange={(e) => setO('usernameClaim', e.target.value)} />
              </Field>
              <Field label="Tên hiển thị">
                <input className="input mono" value={oidc.displayNameClaim} spellCheck={false} onChange={(e) => setO('displayNameClaim', e.target.value)} />
              </Field>
              <Field label="Email">
                <input className="input mono" value={oidc.emailClaim} spellCheck={false} onChange={(e) => setO('emailClaim', e.target.value)} />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Claim nhóm" hint="Không bắt buộc, ví dụ groups.">
                <input className="input mono" value={text(oidc.groupsClaim)} spellCheck={false} onChange={(e) => setO('groupsClaim', e.target.value)} />
              </Field>
              <Field label="Nhóm quản trị" hint="Người có nhóm này trong claim nhóm thành quản trị viên.">
                <input className="input mono" value={text(oidc.adminGroup)} spellCheck={false} onChange={(e) => setO('adminGroup', e.target.value)} />
              </Field>
            </div>
          </fieldset>
          <Toggle
            checked={oidc.autoCreate}
            onChange={(v) => setO('autoCreate', v)}
            label="Tự tạo người dùng khi đăng nhập lần đầu"
            hint="Tắt: chỉ những tên đăng nhập đã được tạo trước ở mục Người dùng mới đăng nhập được."
          />
        </>
      )}
    </FormModal>
  );
}

function TestProvider({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ldap = provider.kind === 'ldap';

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.testProvider(provider.id, ldap && username ? { username, password } : {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Kiểm tra “${provider.name}”`}
      subtitle={ldap ? 'Kết nối và bind bằng tài khoản dịch vụ; nhập thêm một tài khoản để thử đăng nhập.' : 'Kiểm tra cấu hình nhà cung cấp (tự dò địa chỉ, client).'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Đóng</Button>
          <Button variant="primary" icon={<FlaskConical size={16} />} busy={busy} onClick={() => run()}>
            Kiểm tra
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={run}>
        {ldap && (
          <div className="form-row">
            <Field label="Tên đăng nhập (không bắt buộc)">
              <input className="input" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
            </Field>
            <Field label="Mật khẩu">
              <PasswordInput value={password} onChange={setPassword} autoComplete="off" />
            </Field>
          </div>
        )}
        {!ldap && <p className="secondary small">Muốn thử trọn vẹn: đăng xuất và bấm “Đăng nhập với {provider.name}” ở trang đăng nhập.</p>}
        <button type="submit" hidden />
      </form>
      {error && <ErrorBox message={error} />}
      {result && (
        <div className={result.ok ? 'test-result is-ok' : 'test-result is-fail'}>
          {result.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
          <div>
            <strong>{result.ok ? 'Thành công' : 'Thất bại'}</strong>
            <div className="selectable">{result.message}</div>
            {result.user && (
              <dl className="kv kv-compact">
                {Object.entries(result.user).map(([k, v]) => (
                  <div key={k} className="kv-pair">
                    <dt>{k}</dt>
                    <dd className="selectable mono">{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
