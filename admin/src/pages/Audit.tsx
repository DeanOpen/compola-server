// Nhật ký: a filter bar (time frame, person, IP, event type) over rows that read as sentences and expand to the
// raw entry (Customer.io "Audit Logs"; the person column and the time-frame chip from Klaviyo "Activity log").
import { useMemo, useState } from 'react';
import { ChevronRight, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../api';
import { actorUser, AuditSentence, auditDetail } from '../auditView';
import { ACTION_FILTERS, actionLabel, actionTone, formatDateTime, formatRelative, personText, toDate } from '../format';
import { useLoad } from '../hooks';
import { toastError } from '../store';
import type { AuditEntry, User } from '../types';
import { Avatar, Badge, Button, cx, Empty, Loadable, PageHeader, Segmented } from '../ui';

const PAGE = 100;

type Frame = '24h' | '7d' | '30d' | 'all';
const FRAME_MS: Record<Frame, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Infinity };

export function AuditPage() {
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [ip, setIp] = useState('');
  const [frame, setFrame] = useState<Frame>('7d');
  const [open, setOpen] = useState<Set<AuditEntry['id']>>(new Set());
  const users = useLoad<User[]>(() => api.users().catch(() => []), []);
  const [more, setMore] = useState<{ entries: AuditEntry[]; done: boolean }>({ entries: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useLoad(async () => {
    const entries = await api.audit({ limit: PAGE, userId, action });
    setMore({ entries: [], done: entries.length < PAGE });
    return entries;
  }, [userId, action]);

  const userById = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u])), [users.data]);
  const loaded = [...(first.data ?? []), ...more.entries];
  const since = frame === 'all' ? -Infinity : Date.now() - FRAME_MS[frame];
  const at = (e: AuditEntry) => toDate(e.at)?.getTime() ?? 0;
  const entries = loaded.filter((e) => at(e) >= since && (!ip.trim() || e.ip.includes(ip.trim())));
  // Paging goes back in time: once the oldest loaded entry is before the time frame, there is nothing more to load.
  const oldest = loaded[loaded.length - 1];
  const exhausted = more.done || (oldest !== undefined && at(oldest) < since);

  const loadMore = async () => {
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await api.audit({ limit: PAGE, before: oldest.id, userId, action });
      setMore((m) => ({ entries: [...m.entries, ...page], done: page.length < PAGE }));
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id: AuditEntry['id']) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const filtered = !!(userId || action || ip.trim());

  return (
    <div className="page">
      <PageHeader
        title="Nhật ký quản trị"
        subtitle="Đăng nhập, thay đổi cấu hình, quyền và thiết bị trên máy chủ. Việc nhân viên làm trên Zalo xem ở Hoạt động."
        actions={
          <Button icon={<RefreshCw size={16} />} busy={first.loading} onClick={() => first.reload()}>
            Làm mới
          </Button>
        }
      />
      <div className="filter-bar">
        <Segmented<Frame>
          value={frame}
          onChange={setFrame}
          options={[
            { value: '24h', label: '24 giờ' },
            { value: '7d', label: '7 ngày' },
            { value: '30d', label: '30 ngày' },
            { value: 'all', label: 'Mọi lúc' },
          ]}
        />
        <select className="input input-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Người thực hiện">
          <option value="">Mọi người</option>
          {(users.data ?? [])
            .slice()
            .sort((a, b) => a.username.localeCompare(b.username))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {personText(u)}
              </option>
            ))}
        </select>
        <select className="input input-auto" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Loại sự kiện">
          <option value="">Mọi sự kiện</option>
          {ACTION_FILTERS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <input className="input input-ip mono" value={ip} placeholder="IP" spellCheck={false} onChange={(e) => setIp(e.target.value)} aria-label="Lọc theo IP" />
        {filtered && (
          <button
            type="button"
            className="link small"
            onClick={() => {
              setUserId('');
              setAction('');
              setIp('');
            }}
          >
            Xóa bộ lọc
          </button>
        )}
      </div>
      <Loadable state={first}>
        {() =>
          entries.length === 0 ? (
            <>
              <Empty icon={<ScrollText size={28} />} title="Không có sự kiện nào">
                {frame !== 'all' ? 'Thử chọn khoảng thời gian dài hơn.' : undefined}
              </Empty>
              {!exhausted && (
                <div className="center-actions">
                  <Button busy={loadingMore} onClick={loadMore}>
                    Tải thêm sự kiện cũ hơn
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="card audit-list">
                {entries.map((e) => {
                  const actor = actorUser(e, userById);
                  const expanded = open.has(e.id);
                  const detail = auditDetail(e);
                  return (
                    <div key={e.id} className={cx('audit-row', expanded && 'is-open')}>
                      <button type="button" className="audit-main" onClick={() => toggle(e.id)} aria-expanded={expanded}>
                        <Avatar name={actor ? actor.displayName || actor.username : '?'} size={32} />
                        <span className="audit-body">
                          <AuditSentence entry={e} userById={userById} />
                          <span className="audit-meta">
                            <Badge tone={actionTone(e.action)}>{actionLabel(e.action)}</Badge>
                            <span title={formatDateTime(e.at)}>{formatRelative(e.at)}</span>
                            <span className="mono">{e.ip || '—'}</span>
                            {detail && <span className="truncate audit-detail-inline">{detail}</span>}
                          </span>
                        </span>
                        <span className="audit-time hide-sm">{formatDateTime(e.at)}</span>
                        <ChevronRight size={16} className="audit-chevron" />
                      </button>
                      {expanded && (
                        <pre className="audit-json selectable">
                          {JSON.stringify({ id: e.id, at: formatDateTime(e.at), actor: e.actor, action: e.action, target: e.target, ip: e.ip, detail: e.detail }, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="center-actions">
                {exhausted ? (
                  <span className="secondary small">Đã hiện hết {entries.length} sự kiện{frame !== 'all' ? ' trong khoảng thời gian này' : ''}</span>
                ) : (
                  <Button busy={loadingMore} onClick={loadMore}>
                    Xem thêm
                  </Button>
                )}
              </div>
            </>
          )
        }
      </Loadable>
    </div>
  );
}
