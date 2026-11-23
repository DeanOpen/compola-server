// Hoạt động: what each staff member did on the Zalo account (sent, recalled, reacted, read, opened…), newest first.
// Same shape as Nhật ký (Customer.io "Audit Logs" / Klaviyo "Activity log"): a filter bar, rows that read as
// sentences ("Lan (@lan) đã gửi tin nhắn trong «Khách A» · phản hồi sau 3 phút · MacBook Pro #D7F3"), expandable to
// the raw entry; failed calls are greyed with "không thành công". Paging with `before`.
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Download, MessagesSquare, RefreshCw, X } from 'lucide-react';
import { api, type ActivityQuery } from '../api';
import { ACTIVITY_CATEGORIES, ACTIVITY_VERB, CATEGORY_TONE, categoryOf, formatDuration, frameRange, type Frame } from '../activity';
import { formatDateTime, formatRelative, personText, shortId } from '../format';
import { useLoad } from '../hooks';
import { navigate, useRoute } from '../router';
import { toastError } from '../store';
import type { AccountData, ActivityEntry, User } from '../types';
import { Avatar, Badge, Button, cx, DeviceId, Empty, Loadable, Modal, PageHeader, Segmented, SinglePicker } from '../ui';

const PAGE = 100;

/** The device part of a sentence: "MacBook Pro #D7F3A91C", "Chrome · macOS (trình duyệt)", "máy chủ". */
export function ActivityDevice({ device }: { device: ActivityEntry['device'] }) {
  if (device.kind === 'host') return <span>máy chủ</span>;
  if (device.kind === 'web')
    return (
      <span>
        {device.name && device.name !== 'Trình duyệt' ? `${device.name} (trình duyệt)` : 'trình duyệt'}
      </span>
    );
  return (
    <span>
      {device.name || 'thiết bị'} <DeviceId id={device.id} />
    </span>
  );
}

export function ActivitySentence({ e }: { e: ActivityEntry }) {
  const name = e.user ? (e.user.displayName && e.user.displayName !== e.user.username ? e.user.displayName : null) : null;
  const base = ACTIVITY_VERB[e.action] ?? `đã thao tác ${String(e.detail?.call ?? e.action)}`;
  // A refused / failed call: "đã thử gửi tin nhắn … · không thành công".
  const verb = e.ok ? base : base.replace(/^đã /, 'đã thử ');
  // "đã mở hội thoại «X»" but "đã gửi tin nhắn trong «X»".
  const into = e.action.startsWith('conversation.') ? '' : 'trong ';
  return (
    <span className="audit-sentence">
      {e.user ? (
        <span className="audit-person">
          <strong>{name ?? `@${e.user.username}`}</strong>
          {name && <span className="secondary"> (@{e.user.username})</span>}
        </span>
      ) : (
        <strong>Chủ máy</strong>
      )}{' '}
      {verb}
      {e.conversation && (
        <>
          {' '}
          {into}
          <strong>«{e.conversation.name || e.conversation.id}»</strong>
        </>
      )}
      {e.ok && e.responseMs !== null && <span className="activity-response"> · phản hồi sau {formatDuration(e.responseMs)}</span>}
      {!e.ok && <span className="activity-failed"> · không thành công</span>}
    </span>
  );
}

export function ActivityPage() {
  const route = useRoute();
  const [userId, setUserId] = useState(route.query.get('userId') ?? '');
  const [account, setAccount] = useState('');
  const [conversation, setConversation] = useState<{ id: string; name: string } | null>(null);
  const [category, setCategory] = useState('');
  const [frame, setFrame] = useState<Frame>('7d');
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<Set<ActivityEntry['id']>>(new Set());
  useEffect(() => {
    const u = route.query.get('userId');
    if (u !== null) setUserId(u);
  }, [route.query]);

  const users = useLoad<User[]>(() => api.users().catch(() => []), []);
  const account_ = useLoad<AccountData>(() => api.accountData().catch(() => ({ conversations: [], labels: [] })), []);
  // Zalo accounts seen in the last 30 days; the filter stays hidden while there is only the default "" account.
  const accounts = useLoad(
    () =>
      api
        .activityStats({ groupBy: 'account', ...frameRange('30d') })
        .then((s) => s.rows.map((r) => r.key))
        .catch(() => [] as string[]),
    [],
  );
  const showAccounts = (accounts.data ?? []).some((a) => a !== '');

  const query: ActivityQuery = useMemo(
    () => ({
      userId: userId || undefined,
      account: account || undefined,
      conversationId: conversation?.id,
      action: category ? ACTIVITY_CATEGORIES.find((c) => c.key === category)?.actions.join(',') : undefined,
      ...frameRange(frame),
    }),
    // frameRange depends on "now": recomputed when a filter changes or on refresh.
    [userId, account, conversation, category, frame],
  );

  const [more, setMore] = useState<{ entries: ActivityEntry[]; done: boolean }>({ entries: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const first = useLoad(async () => {
    const entries = await api.activity({ ...query, limit: PAGE });
    setMore({ entries: [], done: entries.length < PAGE });
    return entries;
  }, [query]);
  const entries = [...(first.data ?? []), ...more.entries];

  const loadMore = async () => {
    const oldest = entries[entries.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const page = await api.activity({ ...query, limit: PAGE, before: oldest.id });
      setMore((m) => ({ entries: [...m.entries, ...page], done: page.length < PAGE }));
    } catch (e) {
      toastError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id: ActivityEntry['id']) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const filtered = !!(userId || account || conversation || category);
  const exportCsv = () => api.exportActivityCsv(query).catch(toastError);

  return (
    <div className="page">
      <PageHeader
        title="Hoạt động"
        subtitle="Nhân viên đã làm gì trên tài khoản Zalo: gửi, thu hồi, thả cảm xúc, đọc, mở hội thoại…"
        actions={
          <>
            <Button icon={<Download size={16} />} onClick={exportCsv}>
              Xuất CSV
            </Button>
            <Button icon={<RefreshCw size={16} />} busy={first.loading} onClick={() => first.reload()}>
              Làm mới
            </Button>
          </>
        }
      />
      <div className="filter-bar">
        <Segmented<Frame>
          value={frame}
          onChange={setFrame}
          options={[
            { value: 'today', label: 'Hôm nay' },
            { value: '7d', label: '7 ngày' },
            { value: '30d', label: '30 ngày' },
            { value: 'all', label: 'Mọi lúc' },
          ]}
        />
        <select
          className="input input-auto"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            if (route.query.get('userId')) navigate('/activity', true);
          }}
          aria-label="Người"
        >
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
        {showAccounts && (
          <select className="input input-auto" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Tài khoản Zalo">
            <option value="">Mọi tài khoản Zalo</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a} value={a}>
                {a || 'Tài khoản mặc định'}
              </option>
            ))}
          </select>
        )}
        <div className="conv-filter">
          <button type="button" className="input input-auto conv-filter-btn" onClick={() => setPicking(true)}>
            <MessagesSquare size={15} />
            <span className="truncate">{conversation ? conversation.name : 'Mọi hội thoại'}</span>
          </button>
          {conversation && (
            <button type="button" className="search-clear" aria-label="Bỏ lọc hội thoại" onClick={() => setConversation(null)}>
              <X size={14} />
            </button>
          )}
        </div>
        <select className="input input-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Loại thao tác">
          <option value="">Mọi thao tác</option>
          {ACTIVITY_CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        {filtered && (
          <button
            type="button"
            className="link small"
            onClick={() => {
              setUserId('');
              setAccount('');
              setConversation(null);
              setCategory('');
              if (route.query.get('userId')) navigate('/activity', true);
            }}
          >
            Xóa bộ lọc
          </button>
        )}
      </div>
      <Loadable state={first}>
        {() =>
          entries.length === 0 ? (
            <Empty icon={<MessagesSquare size={28} />} title="Chưa có hoạt động nào">
              {frame !== 'all' ? 'Thử chọn khoảng thời gian dài hơn hoặc bỏ bớt bộ lọc.' : undefined}
            </Empty>
          ) : (
            <>
              <div className="card audit-list">
                {entries.map((e) => {
                  const expanded = open.has(e.id);
                  const cat = categoryOf(e.action);
                  const name = e.user ? e.user.displayName || e.user.username : 'Chủ máy';
                  return (
                    <div key={e.id} className={cx('audit-row', expanded && 'is-open', !e.ok && 'is-failed')}>
                      <button type="button" className="audit-main" onClick={() => toggle(e.id)} aria-expanded={expanded}>
                        <Avatar name={name} size={32} />
                        <span className="audit-body">
                          <ActivitySentence e={e} />
                          <span className="audit-meta">
                            <Badge tone={e.ok ? CATEGORY_TONE[cat.key] : 'danger'}>{cat.label}</Badge>
                            <span title={formatDateTime(e.at)}>{formatRelative(e.at)}</span>
                            <ActivityDevice device={e.device} />
                          </span>
                        </span>
                        <span className="audit-time hide-sm">{formatDateTime(e.at)}</span>
                        <ChevronRight size={16} className="audit-chevron" />
                      </button>
                      {expanded && (
                        <pre className="audit-json selectable">
                          {JSON.stringify(
                            {
                              id: e.id,
                              at: formatDateTime(e.at),
                              account: e.account,
                              user: e.user,
                              device: { ...e.device, short: e.device.id ? shortId(e.device.id) : undefined },
                              action: e.action,
                              conversation: e.conversation,
                              messageId: e.messageId,
                              ok: e.ok,
                              responseMs: e.responseMs,
                              detail: e.detail,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="center-actions">
                {more.done ? (
                  <span className="secondary small">Đã hiện hết {entries.length} hoạt động</span>
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
      {picking && (
        <Modal title="Lọc theo hội thoại" onClose={() => setPicking(false)}>
          <SinglePicker
            items={(account_.data?.conversations ?? []).map((c) => ({ id: c.id, label: c.name || c.id, sub: c.isGroup ? 'Nhóm' : 'Cá nhân', avatar: c.avatar, group: c.isGroup }))}
            value={conversation?.id ?? null}
            placeholder="Tìm hội thoại theo tên…"
            onChange={(id) => {
              const c = account_.data?.conversations.find((x) => x.id === id);
              setConversation(c ? { id: c.id, name: c.name } : null);
              setPicking(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
