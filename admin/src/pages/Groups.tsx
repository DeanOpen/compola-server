import { useMemo, useState } from 'react';
import { Pencil, ShieldCheck, Trash2, Users as UsersIcon } from 'lucide-react';
import { api } from '../api';
import { sourceInfo } from '../format';
import type { Loaded } from '../hooks';
import { navigate } from '../router';
import { confirmDialog, toast, toastError } from '../store';
import type { Group, User } from '../types';
import { Avatar, Badge, Empty, Field, FormModal, Loadable, MultiPicker, RowMenu, SearchInput } from '../ui';

/** The "Nhóm" tab of Người dùng & nhóm. */
export function GroupsTab({
  groups,
  users,
  creating,
  onCreateDone,
}: {
  groups: Loaded<Group[]>;
  users: User[];
  creating: boolean;
  onCreateDone: () => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Group | null>(null);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  const shown = (groups.data ?? []).filter((g) => !q.trim() || `${g.name} ${g.description}`.toLowerCase().includes(q.trim().toLowerCase()));

  const remove = async (g: Group) => {
    const ok = await confirmDialog({
      title: `Xóa nhóm “${g.name}”?`,
      message: 'Các quyền cấp cho nhóm này cũng bị xóa; thành viên mất các quyền đó ngay lập tức.',
      confirmLabel: 'Xóa nhóm',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGroup(g.id);
      toast('Đã xóa nhóm');
      void groups.reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm nhóm…" />
      </div>
      <Loadable state={groups}>
        {() =>
          shown.length === 0 ? (
            <Empty icon={<UsersIcon size={28} />} title={q ? 'Không tìm thấy nhóm' : 'Chưa có nhóm nào'}>
              {!q && 'Tạo nhóm (ví dụ “Chăm sóc khách hàng”) rồi cấp quyền cho nhóm ở mục Phân quyền.'}
            </Empty>
          ) : (
            <div className="card-grid">
              {shown.map((g) => (
                <GroupCard key={g.id} group={g} userById={userById} onEdit={() => setEditing(g)} onDelete={() => remove(g)} />
              ))}
            </div>
          )
        }
      </Loadable>
      {(editing || creating) && (
        <GroupEditor
          group={editing}
          users={users}
          onClose={() => {
            setEditing(null);
            onCreateDone();
          }}
          onDone={() => {
            setEditing(null);
            onCreateDone();
            void groups.reload();
          }}
        />
      )}
    </>
  );
}

function GroupCard({ group, userById, onEdit, onDelete }: { group: Group; userById: Map<string, User>; onEdit: () => void; onDelete: () => void }) {
  const members = group.members.map((id) => userById.get(id)).filter((u): u is User => !!u);
  const ldap = group.source !== 'local';
  return (
    <section className="card group-card">
      <div className="card-body">
        <div className="group-head">
          <div className="group-icon">
            <UsersIcon size={18} />
          </div>
          <div className="cell-text">
            <strong className="truncate">{group.name}</strong>
            <span className="secondary small">
              {group.members.length} thành viên {ldap && <Badge tone="info">{sourceInfo(group.source).label}</Badge>}
            </span>
          </div>
          <div className="row-actions">
            <RowMenu
              items={[
                { label: 'Sửa nhóm và thành viên', icon: <Pencil size={15} />, onSelect: onEdit },
                { label: 'Xem quyền của nhóm', icon: <ShieldCheck size={15} />, onSelect: () => navigate(`/grants?group=${encodeURIComponent(group.id)}`) },
                { label: 'Xóa nhóm', icon: <Trash2 size={15} />, danger: true, onSelect: onDelete },
              ]}
            />
          </div>
        </div>
        {group.description && <p className="secondary group-desc">{group.description}</p>}
        {members.length > 0 && (
          <div className="avatar-stack" title={members.map((m) => m.displayName || m.username).join(', ')}>
            {members.slice(0, 8).map((m) => (
              <Avatar key={m.id} name={m.displayName || m.username} size={28} />
            ))}
            {members.length > 8 && <span className="avatar-more">+{members.length - 8}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function GroupEditor({ group, users, onClose, onDone }: { group: Group | null; users: User[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const ldap = !!group && group.source !== 'local';

  const items = useMemo(
    () =>
      users
        .slice()
        .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username))
        .map((u) => ({
          id: u.id,
          label: u.displayName || u.username,
          sub: `@${u.username}${u.email ? ' · ' + u.email : ''}${u.disabled ? ' · đã khóa' : ''}`,
        })),
    [users],
  );

  const submit = async () => {
    if (!name.trim()) throw new Error('Nhập tên nhóm.');
    let id = group?.id;
    if (!group) {
      const created = await api.createGroup({ name: name.trim(), description: description.trim() });
      id = created.id;
    } else if (name.trim() !== group.name || description.trim() !== group.description) {
      await api.updateGroup(group.id, { name: name.trim(), description: description.trim() });
    }
    const changed = !group || members.length !== group.members.length || members.some((m) => !group.members.includes(m));
    if (id && !ldap && changed) await api.setGroupMembers(id, members);
    toast(group ? 'Đã lưu nhóm' : 'Đã tạo nhóm');
    onDone();
  };

  return (
    <FormModal title={group ? `Sửa nhóm “${group.name}”` : 'Tạo nhóm'} onClose={onClose} onSubmit={submit} submitLabel={group ? 'Lưu' : 'Tạo nhóm'} wide>
      <div className="form-row">
        <Field label="Tên nhóm">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Mô tả">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <Field
        group
        label={`Thành viên (${members.length})`}
        hint={ldap ? 'Nhóm đồng bộ từ LDAP: thành viên được cập nhật mỗi khi người dùng đăng nhập, không sửa ở đây.' : undefined}
      >
        {ldap ? (
          <div className="picker-readonly">
            {members.map((id) => {
              const u = users.find((x) => x.id === id);
              return <Badge key={id}>{u ? u.displayName || u.username : id}</Badge>;
            })}
          </div>
        ) : (
          <MultiPicker items={items} selected={members} onChange={setMembers} placeholder="Tìm người dùng…" emptyText="Không có người dùng" />
        )}
      </Field>
    </FormModal>
  );
}
