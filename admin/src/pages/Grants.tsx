import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRoute } from '../router';
import { DataTable, type Column } from '../table';
import { Eye, Globe2, MessagesSquare, Pencil, Plus, ShieldCheck, Tag, Trash2, User as UserIcon, Users as UsersIcon } from 'lucide-react';
import { api } from '../api';
import { effective, scopeCovers, whoSees } from '../access';
import { formatDateTime, ROLE_HINT, roleLabel, scopeSummary } from '../format';
import { useLoad } from '../hooks';
import { confirmDialog, toast, toastError } from '../store';
import type { AccountData, Conversation, EffectiveAccess, Grant, Group, Label, Role, Scope, Subject, User } from '../types';
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

interface Ctx {
  users: User[];
  groups: Group[];
  account: AccountData;
  accountError: string | null;
  userById: Map<string, User>;
  groupById: Map<string, Group>;
  convById: Map<string, Conversation>;
  labelById: Map<string, Label>;
}

function useCtx(users: User[] | undefined, groups: Group[] | undefined, account: AccountData | undefined, accountError: unknown): Ctx {
  return useMemo(() => {
    const acc = account ?? { conversations: [], labels: [] };
    return {
      users: users ?? [],
      groups: groups ?? [],
      account: acc,
      accountError: accountError ? (accountError instanceof Error ? accountError.message : String(accountError)) : null,
      userById: new Map((users ?? []).map((u) => [u.id, u])),
      groupById: new Map((groups ?? []).map((g) => [g.id, g])),
      convById: new Map(acc.conversations.map((c) => [c.id, c])),
      labelById: new Map(acc.labels.map((l) => [l.id, l])),
    };
  }, [users, groups, account, accountError]);
}

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

function ScopeCell({ scope, ctx, max = 3 }: { scope: Scope; ctx: Ctx; max?: number }) {
  if (scope.all)
    return (
      <Badge tone="info">
        <Globe2 size={12} /> Tất cả cuộc trò chuyện
      </Badge>
    );
  const convs = scope.conversations.map((id) => ctx.convById.get(id) ?? { id, name: id, isGroup: false, avatar: '', labels: [] });
  const labels = scope.labels.map((id) => ctx.labelById.get(id) ?? { id, name: id, color: '' });
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
  const account = useLoad(() => api.accountData(), []);
  const ctx = useCtx(users.data, groups.data, account.data, account.error);
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
        subtitle="Ai được dùng tài khoản Zalo này, với vai trò nào và trong những cuộc trò chuyện nào"
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
      {ctx.accountError && tab !== 'user' && (
        <div className="notice notice-warn">
          <span>Chưa lấy được danh sách cuộc trò chuyện của tài khoản Zalo ({ctx.accountError}). Tên cuộc trò chuyện sẽ hiện dưới dạng mã.</span>
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
  const shown = grants
    .filter((g) => (!role || g.role === role) && (!q.trim() || `${subjectName(g.subject, ctx)} ${g.note}`.toLowerCase().includes(q.trim().toLowerCase())))
    .sort((a, b) => subjectName(a.subject, ctx).localeCompare(subjectName(b.subject, ctx)));

  const remove = async (g: Grant) => {
    const ok = await confirmDialog({
      title: 'Thu hồi quyền này?',
      message: `${subjectName(g.subject, ctx)} sẽ mất quyền ${roleLabel(g.role).toLowerCase()} (${scopeSummary(g.scope).toLowerCase()}) ngay lập tức.`,
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
    { key: 'role', header: 'Vai trò', width: 130, sort: (g) => g.role, render: (g) => <RoleBadge role={g.role} /> },
    { key: 'scope', header: 'Phạm vi', className: 'col-scope', render: (g) => <ScopeCell scope={g.scope} ctx={ctx} /> },
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
        </>
      }
      count={`${shown.length} quyền`}
      empty={<span className="secondary">Không có quyền nào khớp bộ lọc.</span>}
    />
  );
}

function conversationItems(ctx: Ctx): PickItem[] {
  return ctx.account.conversations.map((c) => ({
    id: c.id,
    label: c.name || c.id,
    sub: [c.isGroup ? 'Nhóm' : 'Cá nhân', ...c.labels.map((l) => ctx.labelById.get(l)?.name).filter(Boolean)].join(' · '),
    avatar: c.avatar,
    group: c.isGroup,
  }));
}

function GrantEditor({ grant, ctx, onClose, onDone }: { grant: Grant | null; ctx: Ctx; onClose: () => void; onDone: () => void }) {
  const [subjectType, setSubjectType] = useState<Subject['type']>(grant?.subject.type ?? 'user');
  const [subjectId, setSubjectId] = useState<string | null>(grant?.subject.id ?? null);
  const [role, setRole] = useState<Role>(grant?.role ?? 'agent');
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
  const convItems = useMemo(() => conversationItems(ctx), [ctx]);
  // Conversations known to the editor that this scope reaches (directly or through a label).
  const covered = useMemo(
    () => (all ? ctx.account.conversations.length : ctx.account.conversations.filter((c) => scopeCovers({ all, conversations, labels }, c)).length),
    [all, conversations, labels, ctx],
  );
  const unknownConvs = conversations.filter((id) => !ctx.convById.has(id));

  const submit = async () => {
    if (!subjectId) throw new Error(subjectType === 'user' ? 'Chọn người dùng.' : 'Chọn nhóm.');
    if (!all && !conversations.length && !labels.length) throw new Error('Chọn ít nhất một cuộc trò chuyện hoặc nhãn, hoặc bật “Tất cả cuộc trò chuyện”.');
    const body = {
      subject: { type: subjectType, id: subjectId },
      role,
      scope: all ? { all: true, conversations: [], labels: [] } : { all: false, conversations, labels },
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
        <Toggle checked={all} onChange={setAll} label="Tất cả cuộc trò chuyện" hint="Gồm cả các cuộc trò chuyện mới về sau." />
        {!all && (
          <div className="scope-editor">
            <div className="field">
              <span className="field-label small">
                <Tag size={13} /> Nhãn Zalo
              </span>
              {ctx.account.labels.length ? (
                <div className="chips">
                  {ctx.account.labels.map((l) => (
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
                emptyText={ctx.account.conversations.length ? 'Không có kết quả' : 'Chưa có danh sách cuộc trò chuyện'}
              />
              {unknownConvs.length > 0 && <span className="field-hint">{unknownConvs.length} cuộc trò chuyện đã chọn không còn trong danh sách.</span>}
            </div>
            <div className="scope-summary">
              <Eye size={14} /> Thấy được <strong>{covered}</strong> / {ctx.account.conversations.length} cuộc trò chuyện hiện có
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

function ViaList({ grants, ctx, onEdit, conv }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void; conv?: Conversation }) {
  return (
    <ul className="via-list">
      {grants.map((g) => {
        let how: ReactNode = null;
        if (conv) {
          if (g.scope.all) how = 'tất cả cuộc trò chuyện';
          else if (g.scope.conversations.includes(conv.id)) how = 'chọn trực tiếp';
          else {
            const l = conv.labels.find((x) => g.scope.labels.includes(x));
            const label = l ? ctx.labelById.get(l) : undefined;
            how = label ? <>nhãn <LabelChip name={label.name} color={label.color} /></> : 'nhãn';
          }
        }
        return (
          <li key={g.id}>
            {g.subject.type === 'group' ? <UsersIcon size={13} /> : <UserIcon size={13} />}
            <span>
              {g.subject.type === 'group' ? `Nhóm ${subjectName(g.subject, ctx)}` : 'Cấp trực tiếp'} · {roleLabel(g.role)}
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
          <RoleBadge role="admin" /> Quản trị viên thấy mọi cuộc trò chuyện với quyền nhân viên.
        </p>
      ) : access.data === undefined ? (
        access.error ? (
          <ErrorBox message={access.error instanceof Error ? access.error.message : String(access.error)} onRetry={access.reload} />
        ) : (
          <Spinner />
        )
      ) : (
        (() => {
          const a = { ...access.data, scope: access.data.scope ?? { all: false, conversations: [], labels: [] } };
          if (!a.role)
            return (
              <Empty title="Chưa có quyền">
                Người này đăng nhập được nhưng không thấy cuộc trò chuyện nào. Cấp quyền trực tiếp hoặc thêm họ vào một nhóm đã có quyền.
              </Empty>
            );
          const viaLabels = a.scope.all ? [] : ctx.account.conversations.filter((c) => !a.scope.conversations.includes(c.id) && c.labels.some((l) => a.scope.labels.includes(l)));
          const via = a.via.map((v) => grantById.get(v.grantId) ?? { id: v.grantId, subject: v.subject, role: v.role, scope: { all: false, conversations: [], labels: [] }, note: '', createdAt: 0 });
          return (
            <div className="stack">
              <dl className="kv">
                <dt>Vai trò</dt>
                <dd>
                  <RoleBadge role={a.role} />
                  <div className="field-hint">{ROLE_HINT[a.role]}</div>
                </dd>
                <dt>Phạm vi</dt>
                <dd>{scopeSummary(a.scope)}</dd>
                <dt>Từ các quyền</dt>
                <dd>
                  <ViaList grants={via} ctx={ctx} onEdit={onEdit} />
                </dd>
              </dl>
              {!a.scope.all && (
                <>
                  {a.scope.labels.length > 0 && (
                    <div className="field">
                      <span className="field-label small">Nhãn</span>
                      <div className="chips">
                        {a.scope.labels.map((id) => {
                          const l = ctx.labelById.get(id);
                          return <LabelChip key={id} name={l?.name ?? id} color={l?.color ?? ''} />;
                        })}
                      </div>
                    </div>
                  )}
                  <div className="field">
                    <span className="field-label small">Cuộc trò chuyện thấy được ({a.scope.conversations.length + viaLabels.length})</span>
                    <ul className="conv-list">
                      {a.scope.conversations.map((id) => {
                        const c = ctx.convById.get(id);
                        return (
                          <li key={id}>
                            <Avatar name={c?.name ?? id} src={c?.avatar} size={26} group={c?.isGroup} />
                            <span className="truncate">{c?.name ?? id}</span>
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
            </div>
          );
        })()
      )}
    </Card>
  );
}

function ByConversation({ grants, ctx, onEdit }: { grants: Grant[]; ctx: Ctx; onEdit: (g: Grant) => void }) {
  const [convId, setConvId] = useState<string | null>(null);
  const items = useMemo(() => conversationItems(ctx), [ctx]);
  const conv = convId ? ctx.convById.get(convId) : undefined;
  const rows = useMemo(() => (conv ? whoSees(conv, ctx.users, grants, ctx.groups) : []), [conv, ctx, grants]);
  const admins = rows.filter((r) => r.role === 'admin');
  const others = rows.filter((r) => r.role !== 'admin');
  return (
    <div className="split">
      <Card title="Chọn cuộc trò chuyện" pad={false} className="split-side">
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
              </span>
            }
          >
            <div className="stack">
              {conv.labels.length > 0 && (
                <div className="chips">
                  {conv.labels.map((id) => {
                    const l = ctx.labelById.get(id);
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
                        <ViaList grants={r.via} ctx={ctx} onEdit={onEdit} conv={conv} />
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
              <p className="field-hint">Vai trò là vai trò cao nhất của người dùng trên mọi quyền của họ, không riêng cuộc trò chuyện này.</p>
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
