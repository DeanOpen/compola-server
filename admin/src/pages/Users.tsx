import { useMemo, useState } from 'react';
import { Activity as ActivityIcon, ArrowDown, ArrowUp, ArrowUpDown, KeyRound, Lock, LockOpen, MonitorSmartphone, Pencil, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api, ApiError, type UserInput } from '../api';
import { effective } from '../access';
import { formatDateTime, formatRelative, isLocal, personText, sourceInfo, toDate } from '../format';
import { navigate } from '../router';
import type { Loaded } from '../hooks';
import { confirmDialog, toast, toastError, useMe } from '../store';
import type { Grant, Group, Provider, User } from '../types';
import { Avatar, Badge, Empty, Field, FormModal, Loadable, PasswordInput, RowMenu, SearchInput, Toggle } from '../ui';

const MIN_PASSWORD = 8;

function matches(u: User, q: string) {
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
  return n(`${u.username} ${u.displayName} ${u.email}`).includes(n(q));
}

export type UserRoleKey = 'admin' | 'agent' | 'viewer' | 'none' | 'disabled';

/** The effective role of a user (admins first; grants via the user and their groups), for the table and filter. */
export function userRole(u: User, grants: Grant[], groups: Group[]): UserRoleKey {
  if (u.disabled) return 'disabled';
  if (u.isAdmin) return 'admin';
  return effective(u.id, grants, groups).role ?? 'none';
}

const ROLE_CELL: Record<UserRoleKey, { label: string; tone: 'accent' | 'ok' | 'neutral' | 'warn' | 'danger' }> = {
  admin: { label: 'Quản trị viên', tone: 'accent' },
  agent: { label: 'Nhân viên', tone: 'ok' },
  viewer: { label: 'Người xem', tone: 'neutral' },
  none: { label: 'Chưa có quyền', tone: 'warn' },
  disabled: { label: 'Đã khóa', tone: 'danger' },
};

type SortKey = 'name' | 'lastLogin';

/** The "Người dùng" tab of Người dùng & nhóm (Base44 "Members and groups", Plane "Members"). */
export function UsersTab({
  users,
  groups,
  grants,
  providers,
  creating,
  onCreateDone,
}: {
  users: Loaded<User[]>;
  groups: Group[];
  grants: Grant[];
  providers: Provider[];
  creating: boolean;
  onCreateDone: () => void;
}) {
  const me = useMe();
  const [q, setQ] = useState('');
  const [role, setRole] = useState<'' | UserRoleKey>('');
  const [source, setSource] = useState<'' | 'local' | 'ldap' | 'oidc'>('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [modal, setModal] = useState<{ kind: 'edit' | 'password'; user: User } | null>(null);

  const rows = useMemo(() => {
    const list = (users.data ?? [])
      .map((u) => ({ u, role: userRole(u, grants, groups), src: sourceInfo(u.source, providers) }))
      .filter((r) => (!q.trim() || matches(r.u, q.trim())) && (!role || r.role === role) && (!source || r.src.kind === source));
    const t = (u: User) => toDate(u.lastLoginAt)?.getTime() ?? 0;
    return list.sort((a, b) =>
      sort.key === 'name'
        ? sort.dir * (a.u.displayName || a.u.username).localeCompare(b.u.displayName || b.u.username)
        : sort.dir * (t(b.u) - t(a.u)),
    );
  }, [users.data, grants, groups, providers, q, role, source, sort]);

  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? <ArrowDown size={13} /> : <ArrowUp size={13} />) : <ArrowUpDown size={13} className="tertiary" />);

  const remove = async (u: User) => {
    const ok = await confirmDialog({
      title: `Xóa người dùng ${personText(u)}?`,
      message: 'Mọi thiết bị đang đăng nhập bằng tài khoản này bị đăng xuất; các quyền cấp riêng cho người này cũng bị xóa. Không hoàn tác được.',
      confirmLabel: 'Xóa người dùng',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      toast('Đã xóa người dùng');
      void users.reload();
    } catch (e) {
      toastError(e);
    }
  };

  const setDisabled = async (u: User, disabled: boolean) => {
    if (disabled) {
      const ok = await confirmDialog({
        title: `Khóa tài khoản ${personText(u)}?`,
        message: 'Người này không đăng nhập được nữa và mọi thiết bị đang dùng tài khoản này bị ngắt ngay. Có thể mở khóa lại sau.',
        confirmLabel: 'Khóa tài khoản',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.updateUser(u.id, { disabled });
      toast(disabled ? 'Đã khóa tài khoản' : 'Đã mở khóa tài khoản');
      void users.reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm theo tên, @username, email…" />
        <select className="input input-auto" value={role} onChange={(e) => setRole(e.target.value as '' | UserRoleKey)} aria-label="Vai trò">
          <option value="">Mọi vai trò</option>
          {(Object.keys(ROLE_CELL) as UserRoleKey[]).map((k) => (
            <option key={k} value={k}>
              {ROLE_CELL[k].label}
            </option>
          ))}
        </select>
        <select className="input input-auto" value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Xác thực">
          <option value="">Mọi cách xác thực</option>
          <option value="local">Nội bộ</option>
          <option value="ldap">LDAP</option>
          <option value="oidc">SSO</option>
        </select>
      </div>
      <Loadable state={users}>
        {(all) =>
          rows.length === 0 ? (
            <Empty icon={<UserPlus size={28} />} title={all.length ? 'Không có người dùng khớp bộ lọc' : 'Chưa có người dùng'} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th aria-sort={sort.key === 'name' ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" className="th-sort" onClick={() => toggleSort('name')}>
                        Người dùng {sortMark('name')}
                      </button>
                    </th>
                    <th>Vai trò</th>
                    <th>Xác thực</th>
                    <th className="hide-sm" aria-sort={sort.key === 'lastLogin' ? (sort.dir === 1 ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" className="th-sort" onClick={() => toggleSort('lastLogin')}>
                        Hoạt động gần nhất {sortMark('lastLogin')}
                      </button>
                    </th>
                    <th className="col-actions" aria-label="Thao tác" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ u, role: r, src }) => {
                    const self = me?.user.id === u.id;
                    return (
                      <tr key={u.id} className={u.disabled ? 'is-muted' : undefined}>
                        <td>
                          <div className="cell-user">
                            <Avatar name={u.displayName || u.username} size={34} />
                            <div className="cell-text">
                              <span className="truncate">
                                {u.displayName || u.username}
                                {self && <Badge tone="accent">Bạn</Badge>}
                              </span>
                              <span className="secondary small truncate">
                                @{u.username}
                                {u.email && <> · {u.email}</>}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>
                          <Badge tone={ROLE_CELL[r].tone}>{ROLE_CELL[r].label}</Badge>
                        </td>
                        <td>
                          <Badge tone={src.kind === 'local' ? 'neutral' : 'info'}>{src.label}</Badge>
                        </td>
                        <td className="hide-sm nowrap" title={formatDateTime(u.lastLoginAt)}>
                          {formatRelative(u.lastLoginAt)}
                        </td>
                        <td className="col-actions">
                          <RowMenu
                            items={[
                              { label: 'Sửa thông tin', icon: <Pencil size={15} />, onSelect: () => setModal({ kind: 'edit', user: u }) },
                              isLocal(u.source) && { label: 'Đặt lại mật khẩu', icon: <KeyRound size={15} />, onSelect: () => setModal({ kind: 'password', user: u }) },
                              { label: 'Xem quyền truy cập', icon: <ShieldCheck size={15} />, onSelect: () => navigate(`/grants?user=${encodeURIComponent(u.id)}`) },
                              { label: 'Xem hoạt động', icon: <ActivityIcon size={15} />, onSelect: () => navigate(`/activity?userId=${encodeURIComponent(u.id)}`) },
                              { label: 'Xem thiết bị', icon: <MonitorSmartphone size={15} />, onSelect: () => navigate(`/sessions?q=${encodeURIComponent(u.username)}`) },
                              !self &&
                                (u.disabled
                                  ? { label: 'Mở khóa tài khoản', icon: <LockOpen size={15} />, onSelect: () => setDisabled(u, false) }
                                  : { label: 'Khóa tài khoản', icon: <Lock size={15} />, onSelect: () => setDisabled(u, true) }),
                              !self && { label: 'Xóa người dùng', icon: <Trash2 size={15} />, danger: true, onSelect: () => remove(u) },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
      {creating && (
        <CreateUser
          providers={providers}
          existing={users.data ?? []}
          onClose={onCreateDone}
          onDone={() => {
            onCreateDone();
            void users.reload();
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <EditUser
          user={modal.user}
          self={me?.user.id === modal.user.id}
          providers={providers}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            void users.reload();
          }}
        />
      )}
      {modal?.kind === 'password' && <ResetPassword user={modal.user} onClose={() => setModal(null)} />}
    </>
  );
}

function CreateUser({ providers, existing, onClose, onDone }: { providers: Provider[]; existing: User[]; onClose: () => void; onDone: () => void }) {
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [source, setSource] = useState('local');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const local = source === 'local';
  const provider = providers.find((p) => `${p.kind}:${p.id}` === source);

  const submit = async () => {
    setUsernameError(null);
    const wanted = username.trim();
    if (!wanted) {
      setUsernameError('Nhập tên đăng nhập.');
      throw new Error('');
    }
    const taken = existing.find((u) => u.username.toLowerCase() === wanted.toLowerCase());
    if (taken) {
      setUsernameError(`Đã có người dùng «${taken.username}» (${taken.displayName || taken.username}). Tên đăng nhập không phân biệt hoa thường.`);
      throw new Error('');
    }
    if (local) {
      if (password.length < MIN_PASSWORD) throw new Error(`Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`);
      if (password !== password2) throw new Error('Hai mật khẩu không khớp.');
    }
    const input: UserInput = {
      username: username.trim(),
      displayName: displayName.trim() || username.trim(),
      email: email.trim(),
      isAdmin,
    };
    if (local) input.password = password;
    else input.source = source;
    try {
      await api.createUser(input);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setUsernameError(e.message);
        throw new Error('');
      }
      throw e;
    }
    toast('Đã thêm người dùng');
    onDone();
  };

  return (
    <FormModal title="Thêm người dùng" onClose={onClose} onSubmit={submit} submitLabel="Thêm">
      <Field
        label="Loại tài khoản"
        hint={
          local
            ? 'Tài khoản có mật khẩu lưu trên máy chủ này.'
            : `Tạo trước tài khoản ${provider?.kind === 'ldap' ? 'LDAP' : 'SSO'} để cấp quyền trước khi người đó đăng nhập lần đầu. Tên đăng nhập phải trùng với tên ở ${provider?.name ?? 'nguồn đăng nhập'}.`
        }
      >
        <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="local">Tài khoản nội bộ</option>
          {providers.map((p) => (
            <option key={p.id} value={`${p.kind}:${p.id}`}>
              {p.kind === 'ldap' ? 'LDAP' : 'SSO'} · {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Tên đăng nhập"
        error={usernameError}
        hint="Duy nhất trên máy chủ, không phân biệt hoa thường (Lan và lan là một). Đây là tài khoản của một người, không phải tên thiết bị."
      >
        <input
          className="input"
          autoFocus
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          aria-invalid={!!usernameError}
          onChange={(e) => {
            setUsername(e.target.value);
            setUsernameError(null);
          }}
        />
      </Field>
      <div className="form-row">
        <Field label="Tên hiển thị">
          <input className="input" value={displayName} placeholder={username} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      {local && (
        <div className="form-row">
          <Field label="Mật khẩu" hint={`Ít nhất ${MIN_PASSWORD} ký tự`}>
            <PasswordInput value={password} onChange={setPassword} />
          </Field>
          <Field label="Nhập lại mật khẩu">
            <PasswordInput value={password2} onChange={setPassword2} />
          </Field>
        </div>
      )}
      <Toggle checked={isAdmin} onChange={setIsAdmin} label="Quản trị viên" hint="Quản lý máy chủ và thấy mọi cuộc trò chuyện." />
    </FormModal>
  );
}

function EditUser({ user, self, providers, onClose, onDone }: { user: User; self: boolean; providers: Provider[]; onClose: () => void; onDone: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [disabled, setDisabled] = useState(user.disabled);

  const submit = async () => {
    const patch: Parameters<typeof api.updateUser>[1] = {};
    if (displayName.trim() !== user.displayName) patch.displayName = displayName.trim();
    if (email.trim() !== user.email) patch.email = email.trim();
    if (isAdmin !== user.isAdmin) patch.isAdmin = isAdmin;
    if (disabled !== user.disabled) patch.disabled = disabled;
    if (Object.keys(patch).length) {
      await api.updateUser(user.id, patch);
      toast('Đã lưu');
    }
    onDone();
  };

  return (
    <FormModal title={`Sửa “${user.username}”`} subtitle={`${sourceInfo(user.source, providers).label} · tạo lúc ${formatDateTime(user.createdAt)}`} onClose={onClose} onSubmit={submit}>
      <Field label="Tên hiển thị">
        <input className="input" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </Field>
      <Field label="Email">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Toggle checked={isAdmin} onChange={setIsAdmin} disabled={self} label="Quản trị viên" hint={self ? 'Bạn không thể tự bỏ quyền quản trị của mình.' : 'Quản lý máy chủ và thấy mọi cuộc trò chuyện.'} />
      <Toggle checked={disabled} onChange={setDisabled} disabled={self} label="Khóa tài khoản" hint="Không đăng nhập được; các thiết bị đang dùng sẽ bị ngắt." />
    </FormModal>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const submit = async () => {
    if (password.length < MIN_PASSWORD) throw new Error(`Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`);
    if (password !== password2) throw new Error('Hai mật khẩu không khớp.');
    await api.setPassword(user.id, password);
    toast('Đã đặt lại mật khẩu');
    onClose();
  };
  return (
    <FormModal title="Đặt lại mật khẩu" subtitle={user.displayName || user.username} onClose={onClose} onSubmit={submit} submitLabel="Đặt mật khẩu">
      <Field label="Mật khẩu mới" hint={`Ít nhất ${MIN_PASSWORD} ký tự`}>
        <PasswordInput value={password} onChange={setPassword} />
      </Field>
      <Field label="Nhập lại mật khẩu">
        <PasswordInput value={password2} onChange={setPassword2} />
      </Field>
    </FormModal>
  );
}
