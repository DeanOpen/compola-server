import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { toast } from '../store';
import type { ServerInfo } from '../types';
import { Badge, Button, Card, ErrorBox, Field, Loadable, PageHeader } from '../ui';
import { addressText } from './Dashboard';

function normalizeUrl(v: string): string {
  return v.trim().replace(/\/+$/, '');
}

export function SettingsPage() {
  const server = useLoad(() => api.server(), []);
  return (
    <div className="page page-narrow">
      <PageHeader title="Cài đặt máy chủ" />
      <Loadable state={server}>{(s) => <SettingsForm server={s} onSaved={server.reload} />}</Loadable>
    </div>
  );
}

function SettingsForm({ server, onSaved }: { server: ServerInfo; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(server.name);
  const [publicUrl, setPublicUrl] = useState(server.publicUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(server.name);
    setPublicUrl(server.publicUrl);
  }, [server.name, server.publicUrl]);

  const dirty = name.trim() !== server.name || normalizeUrl(publicUrl) !== server.publicUrl;
  const lanSuggestions = server.addresses.map((a) => `http://${addressText(a)}:${server.listen.port}`);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = normalizeUrl(publicUrl);
    if (!name.trim()) return setError('Nhập tên máy chủ.');
    if (url && !/^https?:\/\/[^/\s]+(\/[^\s]*)?$/.test(url)) return setError('Địa chỉ công khai phải có dạng http(s)://tên-miền-hoặc-IP[:cổng]');
    setBusy(true);
    try {
      const patch: { name?: string; publicUrl?: string } = {};
      if (name.trim() !== server.name) patch.name = name.trim();
      if (url !== server.publicUrl) patch.publicUrl = url;
      await api.updateServer(patch);
      toast('Đã lưu cài đặt');
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Card title="Chung">
        <div className="form">
          <Field label="Tên máy chủ" hint="Hiện ở trang đăng nhập và trong ứng dụng Compola khi kết nối.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Địa chỉ công khai"
            hint={
              <>
                Địa chỉ người dùng mở được máy chủ này, dùng để tạo địa chỉ chuyển hướng SSO (
                <code>{(normalizeUrl(publicUrl) || '<địa chỉ>') + '/api/auth/oidc/callback'}</code>) và liên kết đăng nhập thiết bị. Ví dụ{' '}
                <code>https://compola.congty.vn</code> khi đặt sau tunnel / reverse proxy, hoặc <code>http://&lt;IP LAN&gt;:{server.listen.port}</code> trong mạng nội bộ.
              </>
            }
          >
            <input className="input mono" value={publicUrl} spellCheck={false} placeholder="https://compola.congty.vn" onChange={(e) => setPublicUrl(e.target.value)} />
          </Field>
          {lanSuggestions.length > 0 && (
            <div className="chips">
              <span className="secondary small">Dùng địa chỉ LAN:</span>
              {lanSuggestions.map((u) => (
                <button key={u} type="button" className="pill mono" onClick={() => setPublicUrl(u)}>
                  {u}
                </button>
              ))}
            </div>
          )}
          {error && <ErrorBox message={error} />}
          <div className="form-actions">
            <Button type="submit" variant="primary" icon={<Save size={16} />} busy={busy} disabled={!dirty}>
              Lưu
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Mạng">
        <dl className="kv">
          <dt>Cổng</dt>
          <dd className="nums">{server.listen.port}</dd>
          <dt>Truy cập</dt>
          <dd>{server.listen.allowNetwork ? <Badge tone="ok">Mở cho mạng LAN</Badge> : <Badge>Chỉ máy này (127.0.0.1)</Badge>}</dd>
          <dt>Địa chỉ</dt>
          <dd>
            <div className="addr-list">
              {server.addresses.map((a) => (
                <code key={addressText(a)} className="selectable">
                  {addressText(a)}
                  {typeof a === 'object' && a.kind ? <span className="secondary"> ({a.kind})</span> : null}
                </code>
              ))}
              {!server.addresses.length && <span className="secondary">—</span>}
            </div>
          </dd>
          <dt>Phiên bản</dt>
          <dd className="nums">{server.version}</dd>
        </dl>
        <p className="field-hint">Cổng và quyền truy cập mạng được đổi trong ứng dụng Compola trên máy chủ (Cài đặt → Compola Server).</p>
      </Card>
    </form>
  );
}
