// Nhật ký: filter chips (time frame, person, event type, IP) over a table whose rows read as sentences and expand to
// the raw entry (Vanta "Event log", 1Password "Activity log"); CSV export of the loaded rows.
import { useMemo, useState } from 'react';
import { CalendarDays, ChevronRight, Download, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../api';
import { actorUser, AuditSentence, auditDetail } from '../auditView';
import { ACTION_FILTERS, actionLabel, actionTone, detailText, formatDateTime, formatRelative, toDate } from '../format';
import { useLoad } from '../hooks';
import { toastError } from '../store';
import type { AuditEntry, User } from '../types';
import { useRoute } from '../router';
import { DataTable, type Column } from '../table';
import { Badge, Button, Empty, FilterChip, Loadable, PageHeader, Person } from '../ui';

const PAGE = 100;

type Frame = '24h' | '7d' | '30d' | 'all';
const FRAME_MS: Record<Frame, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: Infinity };

const FRAMES: { value: Frame; label: string }[] = [
  { value: '24h', label: '24 giờ qua' },
  { value: '7d', label: '7 ngày qua' },
  { value: '30d', label: '30 ngày qua' },
  { value: 'all', label: 'Mọi lúc' },
];

/** Loaded rows as CSV (Excel-friendly: UTF-8 BOM, quoted fields). */
function toCsv(entries: AuditEntry[]): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Thời gian', 'Người thực hiện', 'Hành động', 'Mã hành động', 'Đối tượng', 'IP', 'Chi tiết'];
  const rows = entries.map((e) => [formatDateTime(e.at), e.actor?.username ?? '', actionLabel(e.action), e.action, e.target, e.ip, detailText(e.detail)].map(q).join(','));
  return '﻿' + [head.map(q).join(','), ...rows].join('\r\n');
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AuditPage() {
  const route = useRoute();
  const [userId, setUserId] = useState(route.query.get('userId') ?? '');
  const [action, setAction] = useState(route.query.get('action') ?? '');
  const [ip, setIp] = useState('');
  const [frame, setFrame] = useState<Frame>('7d');
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

  const filtered = !!(userId || action || ip.trim());
  const people = (users.data ?? [])
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => ({ value: u.id, label: u.displayName || u.username, sub: `@${u.username}` }));

  const columns: Column<AuditEntry>[] = [
    {
      key: 'at',
      header: 'Thời gian',
      width: 150,
      render: (e) => (
        <span className="cell-time" title={formatRelative(e.at)}>
          {formatDateTime(e.at)}
        </span>
      ),
    },
    {
      key: 'actor',
      header: 'Người thực hiện',
      width: 200,
      hideBelow: 860,
      render: (e) => {
        const actor = actorUser(e, userById);
        return actor ? <Person user={actor} size={24} /> : <span className="tertiary">Chưa đăng nhập</span>;
      },
    },
    { key: 'action', header: 'Hành động', width: 180, render: (e) => <Badge tone={actionTone(e.action)}>{actionLabel(e.action)}</Badge> },
    {
      key: 'what',
      header: 'Chi tiết',
      render: (e) => {
        const detail = auditDetail(e);
        return (
          <span className="audit-cell">
            <AuditSentence entry={e} userById={userById} />
            {detail && <span className="secondary small truncate">{detail}</span>}
          </span>
        );
      },
    },
    { key: 'ip', header: 'IP', width: 130, hideBelow: 1100, render: (e) => <span className="cell-mono">{e.ip || '—'}</span> },
    { key: 'chev', header: '', width: 36, render: () => <ChevronRight size={15} className="audit-chevron" /> },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Nhật ký"
        subtitle="Ai đã làm gì: đăng nhập, thay đổi cấu hình, thiết bị và thao tác trên tài khoản Zalo"
        actions={
          <>
            <Button icon={<RefreshCw size={15} />} busy={first.loading} onClick={() => first.reload()}>
              Làm mới
            </Button>
            <Button icon={<Download size={15} />} disabled={!entries.length} onClick={() => download(`compola-nhat-ky-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(entries))}>
              Xuất CSV
            </Button>
          </>
        }
      />
      <Loadable state={first}>
        {() => (
          <DataTable
            className="audit-table"
            rows={entries}
            columns={columns}
            rowKey={(e) => String(e.id)}
            pageSize={0}
            expand={(e) => (
              <pre className="audit-json selectable">
                {JSON.stringify({ id: e.id, at: formatDateTime(e.at), actor: e.actor, action: e.action, target: e.target, ip: e.ip, detail: e.detail }, null, 2)}
              </pre>
            )}
            toolbar={
              <>
                <FilterChip label="Thời gian" icon={<CalendarDays size={14} />} value={frame} clearable={false} options={FRAMES} onChange={(v) => setFrame((v as Frame) ?? '7d')} />
                <FilterChip label="Người thực hiện" value={userId || null} options={people} onChange={(v) => setUserId(v ?? '')} />
                <FilterChip label="Hành động" value={action || null} options={ACTION_FILTERS} onChange={(v) => setAction(v ?? '')} />
                <input className="input input-ip mono" value={ip} placeholder="Lọc theo IP" spellCheck={false} onChange={(e) => setIp(e.target.value)} aria-label="Lọc theo IP" />
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
              </>
            }
            count={`${entries.length} sự kiện`}
            empty={
              <Empty icon={<ScrollText size={22} />} title="Không có sự kiện nào">
                {frame !== 'all' ? 'Thử chọn khoảng thời gian dài hơn.' : undefined}
              </Empty>
            }
            footer={
              <>
                <span className="secondary">
                  {exhausted ? `Đã hiện hết ${entries.length} sự kiện${frame !== 'all' ? ' trong khoảng thời gian này' : ''}` : `Đang hiện ${entries.length} sự kiện mới nhất`}
                </span>
                {!exhausted && (
                  <Button size="sm" busy={loadingMore} onClick={loadMore}>
                    Tải thêm sự kiện cũ hơn
                  </Button>
                )}
              </>
            }
          />
        )}
      </Loadable>
    </div>
  );
}
