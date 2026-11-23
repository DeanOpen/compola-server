// Người dùng & nhóm: one page with stat cards, then Users / Groups tabs (Base44 "Members and groups"; the primary
// "Thêm …" button top-right as in Plane "Members").
import { useState } from 'react';
import { Plus, ShieldCheck, UserCog, Users as UsersIcon, UsersRound } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useRoute } from '../router';
import type { Grant, Provider } from '../types';
import { Button, PageHeader, Stat, Tabs } from '../ui';
import { GroupsTab } from './Groups';
import { UsersTab, userRole } from './Users';

export function MembersPage() {
  const route = useRoute();
  const tab = route.path === '/groups' ? 'groups' : 'users';
  const users = useLoad(() => api.users(), []);
  const groups = useLoad(() => api.groups(), []);
  const grants = useLoad<Grant[]>(() => api.grants().catch(() => []), []);
  const providers = useLoad<Provider[]>(() => api.adminProviders().catch(() => []), []);
  const [creating, setCreating] = useState<'users' | 'groups' | null>(null);

  const list = users.data ?? [];
  const roles = list.map((u) => userRole(u, grants.data ?? [], groups.data ?? []));
  const withAccess = roles.filter((r) => r === 'agent' || r === 'viewer').length;
  const external = list.filter((u) => u.source !== 'local').length;

  return (
    <div className="page">
      <PageHeader
        title="Người dùng & nhóm"
        subtitle="Tài khoản của từng người đăng nhập vào máy chủ, và các nhóm để cấp quyền một lần cho nhiều người"
        actions={
          tab === 'users' ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating('users')}>
              Thêm người dùng
            </Button>
          ) : (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating('groups')}>
              Tạo nhóm
            </Button>
          )
        }
      />
      <div className="stats stats-4">
        <Stat label="Người dùng" icon={<UsersIcon size={18} />} value={users.data ? list.length : '—'} sub={users.data ? `${external} qua LDAP / SSO` : undefined} />
        <Stat label="Quản trị viên" icon={<UserCog size={18} />} value={users.data ? roles.filter((r) => r === 'admin').length : '—'} sub="Quản lý máy chủ, thấy mọi thứ" />
        <Stat
          label="Được dùng Zalo"
          icon={<ShieldCheck size={18} />}
          value={users.data && grants.data ? withAccess : '—'}
          sub={users.data ? `${roles.filter((r) => r === 'none').length} chưa có quyền · ${roles.filter((r) => r === 'disabled').length} bị khóa` : undefined}
        />
        <Stat label="Nhóm" icon={<UsersRound size={18} />} value={groups.data ? groups.data.length : '—'} sub={grants.data ? `${grants.data.filter((g) => g.subject.type === 'group').length} quyền cấp theo nhóm` : undefined} />
      </div>
      <Tabs
        active={tab}
        items={[
          { key: 'users', href: '#/users', label: 'Người dùng', count: users.data?.length },
          { key: 'groups', href: '#/groups', label: 'Nhóm', count: groups.data?.length },
        ]}
      />
      {tab === 'users' ? (
        <UsersTab
          users={users}
          groups={groups.data ?? []}
          grants={grants.data ?? []}
          providers={providers.data ?? []}
          creating={creating === 'users'}
          onCreateDone={() => setCreating(null)}
        />
      ) : (
        <GroupsTab
          groups={groups}
          users={list}
          creating={creating === 'groups'}
          onCreateDone={() => {
            setCreating(null);
            void grants.reload();
          }}
        />
      )}
    </div>
  );
}
