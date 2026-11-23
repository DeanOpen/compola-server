import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { toast } from '../store';
import type { ServerInfo } from '../types';
import { Badge, Button, Card, DescriptionList, ErrorBox, Field, Loadable, PageHeader } from '../ui';
import { addressText } from './Dashboard';

function normalizeUrl(v: string): string {
  return v.trim().replace(/\/+$/, '');
}

export function SettingsPage() {
  const server = useLoad(() => api.server(), []);
  return (
    <div className="page page-narrow">
      <PageHeader title="Cài đặt máy chủ" subtitle="Tên, địa chỉ và mạng của máy chủ Compola này" />
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

  const reset = () => {
    setName(server.name);
    setPublicUrl(server.publicUrl);
    setError(null);
  };

  // Mintlify-style sections: what it is on the left, the controls on the right; a sticky bar while unsaved.
  return (
    <form onSubmit={save} noValidate>
      <Card pad={false}>
        <div className="card-body settings-body">
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Tên máy chủ</h3>
              <p>Hiện ở trang đăng nhập và trong ứng dụng Compola khi người dùng kết nối.</p>
            </div>
            <Field label="Tên hiển thị">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </section>
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Địa chỉ công khai</h3>
              <p>Địa chỉ người dùng mở được máy chủ này. Cần cho đăng nhập SSO và liên kết đăng nhập thiết bị.</p>
            </div>
            <div className="form">
              <Field
                label="URL"
                hint={
                  <>
                    Địa chỉ chuyển hướng SSO: <code>{(normalizeUrl(publicUrl) || '<địa chỉ>') + '/api/auth/oidc/callback'}</code>. Ví dụ{' '}
                    <code>https://compola.congty.vn</code> sau tunnel / reverse proxy, hoặc <code>http://&lt;IP LAN&gt;:{server.listen.port}</code> trong mạng nội bộ.
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
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Mạng</h3>
              <p>Cổng và quyền truy cập mạng được đổi trong ứng dụng Compola trên máy chủ (Cài đặt → Compola Server).</p>
            </div>
            <DescriptionList
              items={[
                { label: 'Cổng', value: <span className="nums">{server.listen.port}</span> },
                { label: 'Truy cập', value: server.listen.allowNetwork ? <Badge tone="ok">Mở cho mạng LAN</Badge> : <Badge>Chỉ máy này (127.0.0.1)</Badge> },
                {
                  label: 'Địa chỉ',
                  value: server.addresses.length ? (
                    <div className="addr-list">
                      {server.addresses.map((a) => (
                        <span key={addressText(a)} className="cell-mono selectable">
                          {addressText(a)}
                          {typeof a === 'object' && a.kind ? <span className="tertiary"> · {a.kind}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="secondary">—</span>
                  ),
                },
                { label: 'Phiên bản', value: <span className="nums">{server.version}</span> },
              ]}
            />
          </section>
        </div>
      </Card>
      {error && <ErrorBox message={error} />}
      {dirty && (
        <div className="save-bar" role="status">
          <span>Có thay đổi chưa lưu</span>
          <Button onClick={reset}>Hủy</Button>
          <Button type="submit" variant="primary" icon={<Save size={15} />} busy={busy}>
            Lưu thay đổi
          </Button>
        </div>
      )}
    </form>
  );
}
