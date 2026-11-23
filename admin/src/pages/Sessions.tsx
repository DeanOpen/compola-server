// Devices / sessions, grouped by person. A person (account) and a device are different things: each group is one
// account (display name, @username, source); each row is one device of that account (device name + short device id,
// IP, first and last seen), since two devices can share a name.
import { useMemo, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import { api } from '../api';
import { formatDateTime, formatRelative, personText, shortId, toDate } from '../format';
import { useInterval, useLoad } from '../hooks';
import { confirmDialog, toast, toastError, useMe } from '../store';
import { useRoute } from '../router';
import type { Provider, Session, User, UserBrief } from '../types';
import { Badge, Button, Card, DeviceLabel, Empty, Loadable, PageHeader, Person, SearchInput, Segmented } from '../ui';

type KindFilter = 'all' | 'device' | 'web' | 'online';

const time = (t: Session['lastSeenAt']) => toDate(t)?.getTime() ?? 0;

export function deviceText(s: Pick<Session, 'kind' | 'deviceName' | 'deviceId'>): string {
  const name = s.deviceName || (s.kind === 'web' ? 'Trình duyệt' : 'Thiết bị không tên');
  return s.deviceId ? `${name} #${shortId(s.deviceId)}` : name;
}

interface PersonGroup {
  key: string;
  user: UserBrief | null;
  account: User | undefined;
  sessions: Session[];
  online: number;
}

export function SessionsPage() {
  const sessions = useLoad(() => api.sessions(), []);
  const users = useLoad<User[]>(() => api.users().catch(() => []), []);
  const providers = useLoad<Provider[]>(() => api.adminProviders().catch(() => []), []);
  useInterval(() => void sessions.reload(), 15000);
  const me = useMe();
  const route = useRoute();
  const [q, setQ] = useState(route.query.get('q') ?? '');
  const [kind, setKind] = useState<KindFilter>('all');

  const groups = useMemo(() => {
    const userById = new Map((users.data ?? []).map((u) => [u.id, u]));
    const nq = q.trim().toLowerCase();
    const shown = (sessions.data ?? [])
      .filter((s) => (kind === 'all' ? true : kind === 'online' ? s.online : s.kind === kind))
      .filter(
        (s) =>
          !nq ||
          `${s.user?.username ?? ''} ${s.user?.displayName ?? ''} ${s.deviceName} ${s.deviceId} ${shortId(s.deviceId)} ${s.ip}`.toLowerCase().includes(nq),
      );
    const map = new Map<string, PersonGroup>();
    for (const s of shown) {
      const key = s.user?.id ?? '?';
      let g = map.get(key);
      if (!g) {
        g = { key, user: s.user, account: s.user ? userById.get(s.user.id) : undefined, sessions: [], online: 0 };
        map.set(key, g);
      }
      g.sessions.push(s);
      if (s.online) g.online++;
    }
    const list = [...map.values()];
    list.forEach((g) => g.sessions.sort((a, b) => Number(b.online) - Number(a.online) || time(b.lastSeenAt) - time(a.lastSeenAt)));
    return list.sort(
      (a, b) => Number(b.online > 0) - Number(a.online > 0) || (a.user?.username ?? '~').localeCompare(b.user?.username ?? '~'),
    );
  }, [sessions.data, users.data, q, kind]);

  const revoke = async (s: Session) => {
    const ok = await confirmDialog({
      title: 'Đăng xuất thiết bị này?',
      message: `${deviceText(s)} (IP ${s.ip || '—'}) của ${personText(s.user)} sẽ bị đăng xuất ngay. Các thiết bị khác của người này không bị ảnh hưởng.`,
      confirmLabel: 'Đăng xuất thiết bị',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeSession(s.id);
      toast('Đã đăng xuất thiết bị');
      sessions.setData((prev) => prev?.filter((x) => x.id !== s.id));
    } catch (e) {
      toastError(e);
    }
  };

  const revokeAll = async (g: PersonGroup) => {
    const targets = g.sessions.filter((s) => s.id !== me?.sessionId);
    const ok = await confirmDialog({
      title: `Đăng xuất ${personText(g.user)} khỏi mọi thiết bị?`,
      message: `${targets.length} thiết bị / trình duyệt sẽ bị đăng xuất ngay và phải đăng nhập lại. Tài khoản và quyền của người này vẫn giữ nguyên.`,
      confirmLabel: 'Đăng xuất mọi thiết bị',
      danger: true,
    });
    if (!ok) return;
    const failed: unknown[] = [];
    for (const s of targets) {
      try {
        await api.revokeSession(s.id);
      } catch (e) {
        failed.push(e);
      }
    }
    if (failed.length) toastError(failed[0]);
    else toast('Đã đăng xuất mọi thiết bị');
    void sessions.reload();
  };

  const total = sessions.data?.length ?? 0;
  const online = sessions.data?.filter((s) => s.online).length ?? 0;
  const people = new Set((sessions.data ?? []).map((s) => s.user?.id)).size;

  return (
    <div className="page">
      <PageHeader
        title="Thiết bị"
        subtitle={
          sessions.data
            ? `${people} người · ${total} thiết bị / trình duyệt · ${online} đang trực tuyến`
            : 'Các thiết bị (ứng dụng Compola) và trình duyệt đang đăng nhập, theo từng người'
        }
      />
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm theo người, tên thiết bị, mã thiết bị, IP…" />
        <Segmented<KindFilter>
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Tất cả' },
            { value: 'online', label: 'Trực tuyến' },
            { value: 'device', label: 'Ứng dụng' },
            { value: 'web', label: 'Trình duyệt' },
          ]}
        />
      </div>
      <Loadable state={sessions}>
        {() =>
          groups.length === 0 ? (
            <Empty icon={<MonitorSmartphone size={28} />} title="Không có thiết bị nào" />
          ) : (
            <div className="stack">
              {groups.map((g) => (
                <PersonSessions key={g.key} currentId={me?.sessionId} group={g} providers={providers.data ?? []} onRevoke={revoke} onRevokeAll={() => revokeAll(g)} />
              ))}
            </div>
          )
        }
      </Loadable>
    </div>
  );
}

function PersonSessions({
  group,
  providers,
  onRevoke,
  onRevokeAll,
  currentId,
}: {
  currentId?: string;
  group: PersonGroup;
  providers: Provider[];
  onRevoke: (s: Session) => void;
  onRevokeAll: () => void;
}) {
  // Names used by more than one of this person's devices: the short id is what tells them apart.
  const nameCount = new Map<string, number>();
  group.sessions.forEach((s) => nameCount.set(s.deviceName, (nameCount.get(s.deviceName) ?? 0) + 1));
  return (
    <Card
      className="person-group"
      pad={false}
      title={
        <Person
          user={group.user}
          source={group.account?.source}
          providers={providers}
          extra={
            <>
              {group.account?.isAdmin && <Badge tone="accent">Quản trị</Badge>}
              {group.account?.disabled && <Badge tone="danger">Đã khóa</Badge>}
            </>
          }
        />
      }
      actions={
        <>
          <span className="secondary small nowrap hide-sm">
            {group.sessions.length} thiết bị{group.online ? ` · ${group.online} trực tuyến` : ''}
          </span>
          {group.sessions.filter((s) => s.id !== currentId).length > 1 && (
            <Button size="sm" variant="danger-ghost" onClick={onRevokeAll}>
              Đăng xuất mọi thiết bị
            </Button>
          )}
        </>
      }
    >
      {/* Client / IP / sign-in / last activity columns with a per-row sign-out (Airtable "Recent account activity",
          Framer "Sessions"). */}
      <table className="table session-table">
        <thead>
          <tr>
            <th>Thiết bị</th>
            <th>IP</th>
            <th className="hide-md">Đăng nhập</th>
            <th>Hoạt động gần nhất</th>
            <th className="col-actions" aria-label="Thao tác" />
          </tr>
        </thead>
        <tbody>
          {group.sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <DeviceLabel
                  kind={s.kind}
                  deviceName={s.deviceName}
                  deviceId={s.deviceId}
                  online={s.online}
                  sub={
                    <>
                      {s.kind === 'web' ? 'Trình duyệt · trang quản trị' : 'Ứng dụng Compola'}
                      {(nameCount.get(s.deviceName) ?? 0) > 1 && s.kind !== 'web' && <span className="same-name"> · trùng tên, xem mã</span>}
                    </>
                  }
                />
              </td>
              <td className="mono small">{s.ip || '—'}</td>
              <td className="hide-md nowrap small">{formatDateTime(s.createdAt)}</td>
              <td className="nowrap small" title={formatDateTime(s.lastSeenAt)}>
                {s.id === currentId ? (
                  <Badge tone="accent">Phiên hiện tại</Badge>
                ) : s.online ? (
                  <span className="ok-text">Đang trực tuyến</span>
                ) : (
                  formatRelative(s.lastSeenAt)
                )}
              </td>
              <td className="col-actions">
                {s.id !== currentId && (
                  <Button size="sm" variant="ghost" onClick={() => onRevoke(s)}>
                    Đăng xuất
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
