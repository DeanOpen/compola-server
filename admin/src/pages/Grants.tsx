import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRoute } from '../router';
import { DataTable, type Column } from '../table';
import { Eye, Globe2, MessagesSquare, Pencil, Plus, ShieldCheck, Tag, Trash2, User as UserIcon, Users as UsersIcon } from 'lucide-react';
import { api } from '../api';
import { ALL_ACCOUNTS, accountName, effective, grantAccount, scopeCovers, whoSees } from '../access';
import { AccountChip } from '../accountsView';
import { formatDateTime, ROLE_HINT, roleLabel, scopeSummary } from '../format';
import { useLoad } from '../hooks';
import { confirmDialog, toast, toastError } from '../store';
import type { AccountData, Conversation, EffectiveAccess, Grant, Group, Role, Scope, Subject, User, ZaloAccount } from '../types';
import {
  Avatar,
  Badge,
  Button,
  Card,
  cx,
  Empty,
  ErrorBox,
  Field,
  FilterChip,
  FormModal,
  LabelChip,
  Loadable,
  MultiPicker,
  PageHeader,
  RowMenu,
  SearchInput,
  Segmented,
  SinglePicker,
  Spinner,
  Toggle,
  type PickItem,
} from '../ui';

type Tab = 'list' | 'user' | 'conversation';

const ROLE_ROWS: { value: Role | 'admin'; label: string; description: string; icon: ReactNode }[] = [
  { value: 'viewer', label: 'Người xem', description: 'Đọc tin nhắn trong phạm vi được cấp; không gửi, không thả cảm xúc, không thu hồi hay ghim.', icon: <Eye size={16} /> },
  { value: 'agent', label: 'Nhân viên', description: 'Đọc và trả lời khách: gửi tin, gửi file, thả cảm xúc… trong phạm vi được cấp.', icon: <MessagesSquare size={16} /> },
  { value: 'admin', label: 'Quản trị viên', description: 'Quản lý máy chủ và thấy mọi cuộc trò chuyện. Không cấp ở đây: bật ở Người dùng → Sửa thông tin.', icon: <ShieldCheck size={16} /> },
];

const EMPTY_DATA: AccountData = { conversations: [], labels: [] };

interface Ctx {
  users: User[];
  groups: Group[];
  userById: Map<string, User>;
  groupById: Map<string, Group>;
  /** The host's Zalo accounts in order (M5); a server without the accounts API shows just "default". */
  accounts: ZaloAccount[];
  accountById: Map<string, ZaloAccount>;
  /** More than one account: show account columns and pickers. */
  multi: boolean;
  /** Conversations and labels per account. */
  data: Map<string, AccountData>;
  dataError: string | null;
}

const PSEUDO_DEFAULT: ZaloAccount = { id: 'default', uid: '', name: '', label: '', avatar: '', order: 0, enabled: true, active: true, phase: 'ready', badge: 0 };

function useCtx(users: User[] | undefined, groups: Group[] | undefined, accounts: ZaloAccount[] | undefined, data: Map<string, AccountData> | undefined, dataError: unknown): Ctx {
  return useMemo(() => {
    const accs = accounts?.length ? accounts : [PSEUDO_DEFAULT];
    return {
      users: users ?? [],
      groups: groups ?? [],
      userById: new Map((users ?? []).map((u) => [u.id, u])),
      groupById: new Map((groups ?? []).map((g) => [g.id, g])),
      accounts: accs,
      accountById: new Map(accs.map((a) => [a.id, a])),
      multi: accs.length > 1,
      data: data ?? new Map(),
      dataError: dataError ? (dataError instanceof Error ? dataError.message : String(dataError)) : null,
    };
  }, [users, groups, accounts, data, dataError]);
}

const dataOf = (ctx: Ctx, account: string) => ctx.data.get(account) ?? EMPTY_DATA;
const convOf = (ctx: Ctx, account: string, id: string) => dataOf(ctx, account).conversations.find((c) => c.id === id);
const labelOf = (ctx: Ctx, account: string, id: string) => dataOf(ctx, account).labels.find((l) => l.id === id);

function subjectName(s: Subject, ctx: Ctx): string {
  if (s.type === 'user') {
    const u = ctx.userById.get(s.id);
    return u ? u.displayName || u.username : `Người dùng đã xóa (${s.id})`;
  }
  return ctx.groupById.get(s.id)?.name ?? `Nhóm đã xóa (${s.id})`;
}

function SubjectCell({ subject, ctx }: { subject: Subject; ctx: Ctx }) {
  const name = subjectName(subject, ctx);
  const user = subject.type === 'user' ? ctx.userById.get(subject.id) : undefined;
  const group = subject.type === 'group' ? ctx.groupById.get(subject.id) : undefined;
  return (
    <div className="cell-user">
      {subject.type === 'group' ? (
        <span className="group-icon group-icon-sm">
          <UsersIcon size={15} />
        </span>
      ) : (
        <Avatar name={name} size={30} />
      )}
      <div className="cell-text">
        <span className="truncate">{name}</span>
        <span className="secondary small truncate">
          {subject.type === 'group' ? `Nhóm · ${group?.members.length ?? 0} thành viên` : user ? `@${user.username}` : ''}
        </span>
      </div>
    </div>
  );
}

function RoleBadge({ role }: { role: Role | 'admin' | string | null }) {
  return <Badge tone={role === 'admin' ? 'accent' : role === 'agent' ? 'ok' : role === 'viewer' ? 'neutral' : 'warn'}>{roleLabel(role as Role)}</Badge>;
}

function ScopeCell({ scope, ctx, account, max = 3 }: { scope: Scope; ctx: Ctx; account: string; max?: number }) {
  if (scope.all)
    return (
      <Badge tone="info">
        <Globe2 size={12} /> Tất cả cuộc trò chuyện
      </Badge>
    );
  const convs = scope.conversations.map((id) => convOf(ctx, account, id) ?? { id, name: id, isGroup: false, avatar: '', labels: [] });
  const labels = scope.labels.map((id) => labelOf(ctx, account, id) ?? { id, name: id, color: '' });
  if (!convs.length && !labels.length) return <span className="tertiary">Không có</span>;
  const extra = Math.max(0, convs.length - max);
  return (
    <div className="scope-cell">
      {labels.map((l) => (
        <LabelChip key={l.id} name={l.name} color={l.color} />
      ))}
      {convs.slice(0, max).map((c) => (
        <span key={c.id} className="conv-pill" title={c.name}>
          <Avatar name={c.name} src={c.avatar} size={18} group={c.isGroup} />
          <span className="truncate">{c.name}</span>
        </span>
      ))}
      {extra > 0 && <span className="secondary small">+{extra}</span>}
    </div>
  );
}

export function GrantsPage() {
  const grants = useLoad(() => api.grants(), []);
  const users = useLoad(() => api.users(), []);
  const groups = useLoad(() => api.groups(), []);
  const accounts = useLoad(() => api.accounts().then((r) => r.accounts).catch(() => [] as ZaloAccount[]), []);
  // Conversations and labels of every account (one request each), for names in the list and the pickers.
  const accountIds = (accounts.data?.length ? accounts.data : [PSEUDO_DEFAULT]).map((a) => a.id).join(',');
  const data = useLoad(
    async () => {
      const ids = accountIds.split(',');
      const all = await Promise.all(ids.map((id) => api.accountData(id === 'default' && ids.length === 1 ? undefined : id)));
      return new Map(ids.map((id, i) => [id, all[i]]));
    },
    [accountIds],
  );
  const ctx = useCtx(users.data, groups.data, accounts.data, data.data, data.error);
  const route = useRoute();
  const linkedUser = route.query.get('user');
  const linkedGroup = route.query.get('group');
  const [tab, setTab] = useState<Tab>(linkedUser ? 'user' : 'list');
  useEffect(() => {
    if (linkedUser) setTab('user');
  }, [linkedUser]);
  const [editing, setEditing] = useState<Grant | 'new' | null>(null);

  return (
    <div className="page">
      <PageHeader
        title="Phân quyền"
        subtitle={ctx.multi ? 'Ai được dùng tài khoản Zalo nào, với vai trò nào và trong những cuộc trò chuyện nào' : 'Ai được dùng tài khoản Zalo này, với vai trò nào và trong những cuộc trò chuyện nào'}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Cấp quyền
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'list', label: 'Danh sách quyền' },
            { value: 'user', label: 'Ai thấy gì' },
            { value: 'conversation', label: 'Theo cuộc trò chuyện' },
          ]}
        />
      </div>
      {ctx.dataError && tab !== 'user' && (
        <div className="notice notice-warn">
          <span>Chưa lấy được danh sách cuộc trò chuyện của tài khoản Zalo ({ctx.dataError}). Tên cuộc trò chuyện sẽ hiện dưới dạng mã.</span>
        </div>
      )}
      <Loadable state={grants}>
        {(list) =>
          tab === 'list' ? (
            <GrantList grants={list} ctx={ctx} onEdit={setEditing} onChanged={grants.reload} initialQuery={linkedGroup ? ctx.groupById.get(linkedGroup)?.name ?? '' : ''} />
          ) : tab === 'user' ? (
            <WhoSeesWhat grants={list} ctx={ctx} onEdit={setEditing} initialUser={linkedUser} />
          ) : (
            <ByConversation grants={list} ctx={ctx} onEdit={setEditing} />
          )
        }
      </Loadable>
      {editing && (
        <GrantEditor
          grant={editing === 'new' ? null : editing}
          ctx={ctx}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void grants.reload();
          }}
        />
      )}
    </div>
  );
}

function GrantList({ grants, ctx, onEdit, onChanged, initialQuery = '' }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void; onChanged: () => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  useEffect(() => setQ(initialQuery), [initialQuery]);
  const [role, setRole] = useState<'' | Role>('');
  const [account, setAccount] = useState<string | null>(null);
  const shown = grants
    .filter((g) => (!role || g.role === role) && (!account || grantAccount(g) === account) && (!q.trim() || `${subjectName(g.subject, ctx)} ${g.note}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => subjectName(a.subject, ctx).localeCompare(subjectName(b.subject, ctx)));

  const remove = async (g: Grant) => {
    const ok = await confirmDialog({
      title: 'Thu hồi quyền này?',
      message: `${subjectName(g.subject, ctx)} sẽ mất quyền ${roleLabel(g.role).toLowerCase()} (${scopeSummary(g.scope).toLowerCase()}) trên ${accountName(ctx.accountById.get(grantAccount(g)), grantAccount(g))} ngay lập tức.`,
      confirmLabel: 'Thu hồi',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGrant(g.id);
      toast('Đã thu hồi quyền');
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };

  if (!grants.length)
    return (
      <Empty icon={<ShieldCheck size={28} />} title="Chưa cấp quyền cho ai">
        Người dùng không phải quản trị viên chỉ dùng được tài khoản Zalo khi có quyền. Bấm “Cấp quyền” để bắt đầu.
      </Empty>
    );

  const columns: Column<Grant>[] = [
    { key: 'subject', header: 'Đối tượng', render: (g) => <SubjectCell subject={g.subject} ctx={ctx} /> },
    ...(ctx.multi || grants.some((g) => grantAccount(g) !== 'default')
      ? [
          {
            key: 'account',
            header: 'Tài khoản Zalo',
            width: 190,
            sort: (g: Grant) => (grantAccount(g) === ALL_ACCOUNTS ? '' : accountName(ctx.accountById.get(grantAccount(g)), grantAccount(g))),
            render: (g: Grant) => <AccountChip id={grantAccount(g)} account={ctx.accountById.get(grantAccount(g))} />,
          } as Column<Grant>,
        ]
      : []),
    { key: 'role', header: 'Vai trò', width: 130, sort: (g) => g.role, render: (g) => <RoleBadge role={g.role} /> },
    { key: 'scope', header: 'Phạm vi', className: 'col-scope', render: (g) => <ScopeCell scope={g.scope} ctx={ctx} account={grantAccount(g)} /> },
    {
      key: 'note',
      header: 'Ghi chú',
      hideBelow: 1100,
      render: (g) => (
        <span className="secondary" title={`Tạo lúc ${formatDateTime(g.createdAt)}`}>
          {g.note || <span className="tertiary">—</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 48,
      className: 'col-actions',
      render: (g) => (
        <RowMenu
          items={[
            { label: 'Sửa quyền', icon: <Pencil size={15} />, onSelect: () => onEdit(g) },
            { label: 'Thu hồi quyền', icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(g) },
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      rows={shown}
      columns={columns}
      rowKey={(g) => g.id}
      toolbar={
        <>
          <SearchInput value={q} onChange={setQ} placeholder="Tìm theo người dùng, nhóm, ghi chú…" />
          <FilterChip
            label="Vai trò"
            value={role || null}
            options={[
              { value: 'agent', label: 'Nhân viên' },
              { value: 'viewer', label: 'Người xem' },
            ]}
            onChange={(v) => setRole((v ?? '') as '' | Role)}
          />
          {ctx.multi && (
            <FilterChip
              label="Tài khoản"
              value={account}
              options={[{ value: ALL_ACCOUNTS, label: 'Tất cả tài khoản (*)' }, ...ctx.accounts.map((a) => ({ value: a.id, label: accountName(a) }))]}
              onChange={setAccount}
            />
          )}
        </>
      }
      count={`${shown.length} quyền`}
      empty={<span className="secondary">Không có quyền nào khớp bộ lọc.</span>}
    />
  );
}

function conversationItems(ctx: Ctx, account: string): PickItem[] {
  const d = dataOf(ctx, account);
  return d.conversations.map((c) => ({
    id: c.id,
    label: c.name || c.id,
    sub: [c.isGroup ? 'Nhóm' : 'Cá nhân', ...c.labels.map((l) => d.labels.find((x) => x.id === l)?.name).filter(Boolean)].join(' · '),
    avatar: c.avatar,
    group: c.isGroup,
  }));
}

function GrantEditor({ grant, ctx, onClose, onDone }: { grant: Grant | null; ctx: Ctx; onClose: () => void; onDone: () => void }) {
  const [subjectType, setSubjectType] = useState<Subject['type']>(grant?.subject.type ?? 'user');
  const [subjectId, setSubjectId] = useState<string | null>(grant?.subject.id ?? null);
  const [role, setRole] = useState<Role>(grant?.role ?? 'agent');
  // The account comes first: conversations and labels belong to one account. "*" = every account (forces all).
  const [account, setAccount] = useState<string>(grant ? grantAccount(grant) : ctx.multi ? '' : 'default');
  const [all, setAll] = useState(grant?.scope.all ?? false);
  const [conversations, setConversations] = useState<string[]>(grant?.scope.conversations ?? []);
  const [labels, setLabels] = useState<string[]>(grant?.scope.labels ?? []);
  const [note, setNote] = useState(grant?.note ?? '');

  const subjectItems: PickItem[] = useMemo(
    () =>
      subjectType === 'user'
        ? ctx.users
            .filter((u) => !u.isAdmin)
            .map((u) => ({ id: u.id, label: u.displayName || u.username, sub: `@${u.username}${u.disabled ? ' · đã khóa' : ''}`, search: u.username }))
        : ctx.groups.map((g) => ({ id: g.id, label: g.name, sub: `${g.members.length} thành viên`, group: true })),
    [subjectType, ctx],
  );
  const everyAccount = account === ALL_ACCOUNTS;
  const scoped = !!account && !everyAccount;
  const accData = scoped ? dataOf(ctx, account) : EMPTY_DATA;
  const convItems = useMemo(() => (scoped ? conversationItems(ctx, account) : []), [ctx, account, scoped]);
  // Conversations known to the editor that this scope reaches (directly or through a label).
  const covered = useMemo(
    () => (all ? accData.conversations.length : accData.conversations.filter((c) => scopeCovers({ all, conversations, labels }, c)).length),
    [all, conversations, labels, accData],
  );
  const unknownConvs = conversations.filter((id) => !accData.conversations.some((c) => c.id === id));
  const pickAccount = (id: string) => {
    if (id === account) return;
    setAccount(id);
    // Conversation and label ids belong to one account.
    setConversations([]);
    setLabels([]);
    if (id === ALL_ACCOUNTS) setAll(true);
  };

  const submit = async () => {
    if (!account) throw new Error('Chọn tài khoản Zalo.');
    if (!subjectId) throw new Error(subjectType === 'user' ? 'Chọn người dùng.' : 'Chọn nhóm.');
    const allScope = all || everyAccount;
    if (!allScope && !conversations.length && !labels.length) throw new Error('Chọn ít nhất một cuộc trò chuyện hoặc nhãn, hoặc bật “Tất cả cuộc trò chuyện”.');
    const body = {
      subject: { type: subjectType, id: subjectId },
      account,
      role,
      scope: allScope ? { all: true, conversations: [], labels: [] } : { all: false, conversations, labels },
      note: note.trim(),
    };
    if (grant) await api.updateGrant(grant.id, body);
    else await api.createGrant(body);
    toast(grant ? 'Đã lưu quyền' : 'Đã cấp quyền');
    onDone();
  };

  const adminNote = subjectType === 'user' && ctx.users.some((u) => u.isAdmin);

  return (
    <FormModal title={grant ? 'Sửa quyền' : 'Cấp quyền'} onClose={onClose} onSubmit={submit} submitLabel={grant ? 'Lưu' : 'Cấp quyền'} wide>
      {ctx.multi && (
        <Field group label="Tài khoản Zalo" hint="Mỗi tài khoản có danh sách cuộc trò chuyện và nhãn riêng, nên chọn tài khoản trước.">
          <div className="account-options" role="radiogroup">
            {[{ id: ALL_ACCOUNTS }, ...ctx.accounts].map((a) => (
              <label key={a.id} className={cx('account-option', account === a.id && 'is-active')}>
                <input type="radio" name="account" checked={account === a.id} onChange={() => pickAccount(a.id)} />
                <AccountChip id={a.id} account={a.id === ALL_ACCOUNTS ? null : (a as ZaloAccount)} size={24} />
                {a.id === ALL_ACCOUNTS && <span className="secondary small">kể cả tài khoản thêm sau</span>}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field
        group
        label="Cấp cho"
        hint={adminNote ? 'Quản trị viên không có trong danh sách: họ luôn thấy mọi cuộc trò chuyện.' : undefined}
      >
        <Segmented<Subject['type']>
          value={subjectType}
          onChange={(t) => {
            setSubjectType(t);
            setSubjectId(null);
          }}
          options={[
            { value: 'user', label: <><UserIcon size={14} /> Người dùng</> },
            { value: 'group', label: <><UsersIcon size={14} /> Nhóm</> },
          ]}
        />
        {subjectItems.length ? (
          <SinglePicker items={subjectItems} value={subjectId} onChange={setSubjectId} placeholder={subjectType === 'user' ? 'Tìm người dùng…' : 'Tìm nhóm…'} height={180} />
        ) : (
          <p className="secondary small">{subjectType === 'user' ? 'Chưa có người dùng (không phải quản trị viên).' : 'Chưa có nhóm nào.'}</p>
        )}
      </Field>

      <Field group label="Vai trò" hint="Mỗi người có vai trò cao nhất trong mọi quyền của họ (cấp riêng và qua nhóm).">
        {/* Stacked role list with a one-line, plain-language description per role (Plain "Roles"). */}
        <div className="role-list" role="radiogroup">
          {ROLE_ROWS.map((r) => (
            <label key={r.value} className={cx('role-row', role === r.value && 'is-active', r.value === 'admin' && 'is-disabled')}>
              <input
                type="radio"
                name="role"
                disabled={r.value === 'admin'}
                checked={r.value !== 'admin' && role === r.value}
                onChange={() => r.value !== 'admin' && setRole(r.value)}
              />
              <span className="role-row-icon">{r.icon}</span>
              <span className="role-row-text">
                <strong>{r.label}</strong>
                <span className="secondary small">{r.description}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Field group label="Phạm vi">
        <Toggle
          checked={all || everyAccount}
          onChange={setAll}
          disabled={everyAccount || !account}
          label="Tất cả cuộc trò chuyện"
          hint={
            everyAccount
              ? 'Bắt buộc khi cấp cho tất cả tài khoản: mỗi tài khoản có cuộc trò chuyện và nhãn riêng, nên không thể chọn từng cuộc trò chuyện cho mọi tài khoản.'
              : !account
                ? 'Chọn tài khoản Zalo trước.'
                : 'Gồm cả các cuộc trò chuyện mới về sau.'
          }
        />
        {scoped && !all && (
          <div className="scope-editor">
            <div className="field">
              <span className="field-label small">
                <Tag size={13} /> Nhãn Zalo
              </span>
              {accData.labels.length ? (
                <div className="chips">
                  {accData.labels.map((l) => (
                    <LabelChip
                      key={l.id}
                      name={l.name}
                      color={l.color}
                      active={labels.includes(l.id)}
                      onClick={() => setLabels((prev) => (prev.includes(l.id) ? prev.filter((x) => x !== l.id) : [...prev, l.id]))}
                    />
                  ))}
                </div>
              ) : (
                <span className="secondary small">Tài khoản chưa có nhãn.</span>
              )}
              <span className="field-hint">Mọi cuộc trò chuyện gắn nhãn đã chọn, kể cả khi gắn nhãn về sau.</span>
            </div>
            <div className="field">
              <span className="field-label small">
                <MessagesSquare size={13} /> Cuộc trò chuyện ({conversations.length})
              </span>
              <MultiPicker
                items={convItems}
                selected={conversations}
                onChange={setConversations}
                placeholder="Tìm cuộc trò chuyện…"
                filters={[
                  { label: 'Nhóm', test: (i) => !!i.group },
                  { label: 'Cá nhân', test: (i) => !i.group },
                ]}
                emptyText={accData.conversations.length ? 'Không có kết quả' : 'Chưa có danh sách cuộc trò chuyện của tài khoản này'}
              />
              {unknownConvs.length > 0 && <span className="field-hint">{unknownConvs.length} cuộc trò chuyện đã chọn không còn trong danh sách.</span>}
            </div>
            <div className="scope-summary">
              <Eye size={14} /> Thấy được <strong>{covered}</strong> / {accData.conversations.length} cuộc trò chuyện hiện có
            </div>
          </div>
        )}
      </Field>

      <Field label="Ghi chú" hint="Không bắt buộc, ví dụ “Ca tối, nhóm bán hàng”.">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormModal>
  );
}

function ViaList({ grants, ctx, onEdit, conv, account }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void; conv?: Conversation; account?: string }) {
  return (
    <ul className="via-list">
      {grants.map((g) => {
        let how: ReactNode = null;
        if (conv) {
          if (g.scope.all) how = 'tất cả cuộc trò chuyện';
          else if (g.scope.conversations.includes(conv.id)) how = 'chọn trực tiếp';
          else {
            const l = conv.labels.find((x) => g.scope.labels.includes(x));
            const label = l && account ? labelOf(ctx, account, l) : undefined;
            how = label ? <>nhãn <LabelChip name={label.name} color={label.color} /></> : 'nhãn';
          }
        }
        return (
          <li key={g.id}>
            {g.subject.type === 'group' ? <UsersIcon size={13} /> : <UserIcon size={13} />}
            <span>
              {g.subject.type === 'group' ? `Nhóm ${subjectName(g.subject, ctx)}` : 'Cấp trực tiếp'} · {roleLabel(g.role)}
              {grantAccount(g) === ALL_ACCOUNTS && ctx.multi && <> · mọi tài khoản</>}
              {how && <> · {how}</>}
            </span>
            <button type="button" className="link small" onClick={() => onEdit(g)}>
              Sửa
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WhoSeesWhat({ grants, ctx, onEdit, initialUser }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void; initialUser?: string | null }) {
  const [userId, setUserId] = useState<string | null>(initialUser ?? null);
  useEffect(() => {
    if (initialUser) setUserId(initialUser);
  }, [initialUser]);
  const items: PickItem[] = useMemo(
    () =>
      ctx.users.map((u) => {
        const eff = u.isAdmin ? null : effective(u.id, grants, ctx.groups);
        return {
          id: u.id,
          label: u.displayName || u.username,
          sub: u.isAdmin ? `@${u.username} · Quản trị viên` : `@${u.username} · ${eff?.role ? roleLabel(eff.role) : 'Chưa có quyền'}`,
        };
      }),
    [ctx, grants],
  );
  const user = userId ? ctx.userById.get(userId) : undefined;
  return (
    <div className="split">
      <Card title="Chọn người dùng" pad={false} className="split-side">
        <SinglePicker items={items} value={userId} onChange={setUserId} placeholder="Tìm người dùng…" height={480} />
      </Card>
      <div className="split-main">
        {user ? (
          <UserAccess key={user.id} user={user} grants={grants} ctx={ctx} onEdit={onEdit} />
        ) : (
          <Empty icon={<Eye size={28} />} title="Ai thấy gì">
            Chọn một người dùng để xem vai trò và các cuộc trò chuyện người đó thấy được, cùng các quyền tạo nên điều đó.
          </Empty>
        )}
      </div>
    </div>
  );
}

function UserAccess({ user, grants, ctx, onEdit }: { user: User; grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void }) {
  const access = useLoad<EffectiveAccess>(() => api.access(user.id), [user.id, grants]);
  const grantById = new Map(grants.map((g) => [g.id, g]));
  return (
    <Card
      title={
        <span className="cell-user">
          <Avatar name={user.displayName || user.username} size={30} />
          <span>{user.displayName || user.username}</span>
        </span>
      }
    >
      {user.disabled && <ErrorBox message="Tài khoản đang bị khóa: không đăng nhập được dù có quyền." />}
      {user.isAdmin ? (
        <p>
          <RoleBadge role="admin" /> Quản trị viên thấy mọi cuộc trò chuyện của mọi tài khoản Zalo với quyền nhân viên.
        </p>
      ) : access.data === undefined ? (
        access.error ? (
          <ErrorBox message={access.error instanceof Error ? access.error.message : String(access.error)} onRetry={access.reload} />
        ) : (
          <Spinner />
        )
      ) : (
        (() => {
          const a = access.data;
          const ids = Object.keys(a.accounts);
          if (!ids.length)
            return (
              <Empty title="Chưa có quyền">
                Người này đăng nhập được nhưng không thấy cuộc trò chuyện nào. Cấp quyền trực tiếp hoặc thêm họ vào một nhóm đã có quyền.
              </Empty>
            );
          const order = ctx.accounts.map((x) => x.id);
          ids.sort((x, y) => (order.indexOf(x) + 1 || 999) - (order.indexOf(y) + 1 || 999));
          const grantOf = (v: EffectiveAccess['via'][number]): Grant =>
            grantById.get(v.grantId) ?? { id: v.grantId, subject: v.subject, account: v.account, role: v.role, scope: v.scope ?? { all: false, conversations: [], labels: [] }, note: '', createdAt: 0 };
          return (
            <div className="account-access-list">
              {ids.map((id) => {
                const acc = a.accounts[id];
                const scope = acc.scope ?? { all: false, conversations: [], labels: [] };
                const d = dataOf(ctx, id);
                const via = a.via.filter((v) => (v.account || 'default') === id || v.account === ALL_ACCOUNTS).map(grantOf);
                const viaLabels = scope.all ? [] : d.conversations.filter((c) => !scope.conversations.includes(c.id) && c.labels.some((l) => scope.labels.includes(l)));
                return (
                  <section key={id} className="account-access">
                    <div className="account-access-head">
                      {(ctx.multi || id !== 'default') && <AccountChip id={id} account={ctx.accountById.get(id)} size={24} />}
                      <RoleBadge role={acc.role} />
                      <span className="secondary small">{scopeSummary(scope)}</span>
                    </div>
                    <div className="field-hint">{ROLE_HINT[acc.role]}</div>
                    <div className="field">
                      <span className="field-label small">Từ các quyền</span>
                      <ViaList grants={via} ctx={ctx} onEdit={onEdit} account={id} />
                    </div>
                    {!scope.all && (
                      <>
                        {scope.labels.length > 0 && (
                          <div className="field">
                            <span className="field-label small">Nhãn</span>
                            <div className="chips">
                              {scope.labels.map((l) => {
                                const x = labelOf(ctx, id, l);
                                return <LabelChip key={l} name={x?.name ?? l} color={x?.color ?? ''} />;
                              })}
                            </div>
                          </div>
                        )}
                        <div className="field">
                          <span className="field-label small">Cuộc trò chuyện thấy được ({scope.conversations.length + viaLabels.length})</span>
                          <ul className="conv-list">
                            {scope.conversations.map((cid) => {
                              const c = convOf(ctx, id, cid);
                              return (
                                <li key={cid}>
                                  <Avatar name={c?.name ?? cid} src={c?.avatar} size={26} group={c?.isGroup} />
                                  <span className="truncate">{c?.name ?? cid}</span>
                                </li>
                              );
                            })}
                            {viaLabels.map((c) => (
                              <li key={c.id}>
                                <Avatar name={c.name} src={c.avatar} size={26} group={c.isGroup} />
                                <span className="truncate">{c.name}</span>
                                <span className="secondary small">qua nhãn</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </>
                    )}
                  </section>
                );
              })}
            </div>
          );
        })()
      )}
    </Card>
  );
}

function ByConversation({ grants, ctx, onEdit }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void }) {
  // Keyed by (account, conversation): conversation ids are per account.
  const [account, setAccount] = useState<string>(ctx.accounts[0]?.id ?? 'default');
  const [convId, setConvId] = useState<string | null>(null);
  const items = useMemo(() => conversationItems(ctx, account), [ctx, account]);
  const conv = convId ? convOf(ctx, account, convId) : undefined;
  const rows = useMemo(() => (conv ? whoSees(account, conv, ctx.users, grants, ctx.groups) : []), [account, conv, ctx, grants]);
  const admins = rows.filter((r) => r.role === 'admin');
  const others = rows.filter((r) => r.role !== 'admin');
  return (
    <div className="split">
      <Card title="Chọn cuộc trò chuyện" pad={false} className="split-side">
        {ctx.multi && (
          <div className="split-side-head">
            <select
              className="input"
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setConvId(null);
              }}
              aria-label="Tài khoản Zalo"
            >
              {ctx.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {accountName(a)}
                </option>
              ))}
            </select>
          </div>
        )}
        {items.length ? (
          <SinglePicker items={items} value={convId} onChange={setConvId} placeholder="Tìm cuộc trò chuyện…" height={480} />
        ) : (
          <div className="card-body secondary">Chưa có danh sách cuộc trò chuyện.</div>
        )}
      </Card>
      <div className="split-main">
        {conv ? (
          <Card
            title={
              <span className="cell-user">
                <Avatar name={conv.name} src={conv.avatar} size={30} group={conv.isGroup} />
                <span>{conv.name}</span>
                {ctx.multi && (
                  <span className="secondary small">
                    · <AccountChip id={account} account={ctx.accountById.get(account)} size={18} />
                  </span>
                )}
              </span>
            }
          >
            <div className="stack">
              {conv.labels.length > 0 && (
                <div className="chips">
                  {conv.labels.map((id) => {
                    const l = labelOf(ctx, account, id);
                    return <LabelChip key={id} name={l?.name ?? id} color={l?.color ?? ''} />;
                  })}
                </div>
              )}
              {others.length ? (
                <ul className="list list-flush">
                  {others.map((r) => (
                    <li key={r.user.id} className="list-row list-row-top">
                      <Avatar name={r.user.displayName || r.user.username} size={32} />
                      <span className="list-main">
                        <span>
                          {r.user.displayName || r.user.username} <RoleBadge role={r.role} />
                        </span>
                        <ViaList grants={r.via} ctx={ctx} onEdit={onEdit} conv={conv} account={account} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="secondary">Ngoài quản trị viên, chưa ai thấy cuộc trò chuyện này.</p>
              )}
              {admins.length > 0 && (
                <p className="secondary small">
                  Quản trị viên (luôn thấy): {admins.map((r) => r.user.displayName || r.user.username).join(', ')}
                </p>
              )}
              <p className="field-hint">Vai trò là vai trò cao nhất của người dùng trên mọi quyền của họ ở tài khoản này, không riêng cuộc trò chuyện này.</p>
            </div>
          </Card>
        ) : (
          <Empty icon={<MessagesSquare size={28} />} title="Ai thấy cuộc trò chuyện này?">
            Chọn một cuộc trò chuyện để xem những người dùng (trực tiếp hoặc qua nhóm, qua nhãn) thấy được nó.
          </Empty>
        )}
      </div>
    </div>
  );
}
