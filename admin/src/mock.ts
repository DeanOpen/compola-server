// In-memory Compola Server for `npm run dev:admin` with `?mock=1`: every endpoint of docs/compola-server.md, enough
// to click through all screens. Loaded with a dynamic import only in mock mode; not part of a production build.
import { effective } from './access';
import type { AuditEntry, Conversation, Grant, Group, Label, Provider, ServerInfo, Session, User } from './types';

type Res = { status: number; body: unknown };

const now = Date.now();
const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;
let seq = 1000;
const nid = (p: string) => `${p}_${(++seq).toString(36)}`;

const users: User[] = [
  { id: 'u_admin', username: 'admin', displayName: 'Nguyễn Quản Trị', email: 'admin@congty.vn', source: 'local', isAdmin: true, disabled: false, createdAt: now - 40 * day, lastLoginAt: now - 5 * min },
  { id: 'u_lan', username: 'lan', displayName: 'Trần Thị Lan', email: 'lan@congty.vn', source: 'local', isAdmin: false, disabled: false, createdAt: now - 30 * day, lastLoginAt: now - 2 * hour },
  { id: 'u_minh', username: 'minh', displayName: 'Lê Văn Minh', email: 'minh@congty.vn', source: 'ldap:p_ldap', isAdmin: false, disabled: false, createdAt: now - 20 * day, lastLoginAt: now - day },
  { id: 'u_hoa', username: 'hoa.pham', displayName: 'Phạm Thu Hoa', email: 'hoa.pham@congty.vn', source: 'oidc:p_google', isAdmin: false, disabled: false, createdAt: now - 12 * day, lastLoginAt: now - 3 * day },
  { id: 'u_tuan', username: 'tuan', displayName: 'Đỗ Anh Tuấn', email: '', source: 'local', isAdmin: false, disabled: true, createdAt: now - 60 * day, lastLoginAt: now - 45 * day },
  { id: 'u_vy', username: 'vy.nguyen', displayName: 'Nguyễn Thảo Vy', email: 'vy@congty.vn', source: 'ldap:p_ldap', isAdmin: false, disabled: false, createdAt: now - 5 * day, lastLoginAt: null },
  { id: 'u_khoa', username: 'khoa', displayName: 'Bùi Đăng Khoa', email: 'khoa@congty.vn', source: 'local', isAdmin: true, disabled: false, createdAt: now - 90 * day, lastLoginAt: now - 6 * day },
];

const groups: Group[] = [
  { id: 'g_cskh', name: 'Chăm sóc khách hàng', description: 'Trả lời khách trên Zalo', source: 'local', members: ['u_lan', 'u_vy'] },
  { id: 'g_sales', name: 'Bán hàng', description: 'Nhóm kinh doanh miền Bắc', source: 'ldap:p_ldap', members: ['u_minh', 'u_vy'] },
  { id: 'g_ketoan', name: 'Kế toán', description: '', source: 'local', members: ['u_hoa'] },
];

const labels: Label[] = [
  { id: 'l_khach', name: 'Khách hàng', color: '#0068ff' },
  { id: 'l_vip', name: 'VIP', color: '#e5484d' },
  { id: 'l_ncc', name: 'Nhà cung cấp', color: '#37b361' },
  { id: 'l_cho', name: 'Chờ xử lý', color: '#e0ac00' },
  { id: 'l_noibo', name: 'Nội bộ', color: '#8e4ec6' },
];

const convNames: [string, boolean, string[]][] = [
  ['Nguyễn Văn An', false, ['l_khach']],
  ['Shop Hoa Tươi Sài Gòn', false, ['l_khach', 'l_vip']],
  ['Nhóm Kinh doanh HN', true, ['l_noibo']],
  ['Trần Minh Đức', false, ['l_khach', 'l_cho']],
  ['Công ty Vận tải Bắc Nam', false, ['l_ncc']],
  ['Phòng Kế toán', true, ['l_noibo']],
  ['Lê Thị Hồng', false, ['l_khach']],
  ['Khách sỉ miền Trung', true, ['l_khach']],
  ['Phạm Quốc Bảo', false, []],
  ['Võ Thị Mai', false, ['l_vip']],
  ['Hội chợ Xuân 2027', true, []],
  ['Đặng Hữu Phước', false, ['l_cho']],
  ['Nhà in Minh Khang', false, ['l_ncc']],
  ['CSKH ca tối', true, ['l_noibo']],
  ['Hoàng Gia Huy', false, ['l_khach']],
  ['Ngô Thanh Tâm', false, []],
  ['Đại lý Hải Phòng', true, ['l_khach', 'l_vip']],
  ['Trương Mỹ Linh', false, ['l_khach']],
];
const conversations: Conversation[] = convNames.map(([name, isGroup, ls], i) => ({
  id: `${isGroup ? 'g' : 'u'}${7_000_000 + i * 1373}`,
  name,
  isGroup,
  avatar: '',
  labels: ls,
}));

const grants: Grant[] = [
  { id: 'gr_1', subject: { type: 'group', id: 'g_cskh' }, role: 'agent', scope: { all: false, conversations: [conversations[0].id, conversations[3].id, conversations[13].id], labels: ['l_khach'] }, note: 'Ca ngày', createdAt: now - 20 * day },
  { id: 'gr_2', subject: { type: 'group', id: 'g_sales' }, role: 'agent', scope: { all: false, conversations: [conversations[2].id], labels: ['l_vip'] }, note: '', createdAt: now - 15 * day },
  { id: 'gr_3', subject: { type: 'user', id: 'u_hoa' }, role: 'viewer', scope: { all: false, conversations: [conversations[5].id, conversations[4].id], labels: ['l_ncc'] }, note: 'Đối soát công nợ', createdAt: now - 10 * day },
  { id: 'gr_4', subject: { type: 'user', id: 'u_minh' }, role: 'viewer', scope: { all: true, conversations: [], labels: [] }, note: 'Trưởng nhóm: xem toàn bộ', createdAt: now - 8 * day },
];

const providers: Provider[] = [
  {
    id: 'p_ldap',
    kind: 'ldap',
    name: 'AD Công ty',
    enabled: true,
    config: {
      url: 'ldaps://dc01.congty.local:636',
      startTls: false,
      bindDn: 'cn=compola,ou=services,dc=congty,dc=local',
      bindPassword: '••••',
      userBaseDn: 'ou=people,dc=congty,dc=local',
      userFilter: '(sAMAccountName={username})',
      usernameAttr: 'sAMAccountName',
      displayNameAttr: 'displayName',
      emailAttr: 'mail',
      groupBaseDn: 'ou=groups,dc=congty,dc=local',
      groupFilter: '(member={dn})',
      groupNameAttr: 'cn',
      adminGroup: 'Compola Admins',
      autoCreate: true,
    },
  },
  {
    id: 'p_google',
    kind: 'oidc',
    name: 'Google Workspace',
    enabled: true,
    config: {
      issuer: 'https://accounts.google.com',
      clientId: '1234567890-abc.apps.googleusercontent.com',
      clientSecret: '••••',
      scopes: 'openid profile email',
      usernameClaim: 'email',
      displayNameClaim: 'name',
      emailClaim: 'email',
      groupsClaim: '',
      adminGroup: '',
      autoCreate: false,
    },
  },
];

const sessions: Session[] = [
  { id: 's_1', user: { id: 'u_admin', username: 'admin', displayName: 'Nguyễn Quản Trị' }, kind: 'web', deviceId: '', deviceName: 'Chrome · macOS', ip: '192.168.1.20', createdAt: now - 2 * hour, lastSeenAt: now - min, online: true, current: true },
  { id: 's_2', user: { id: 'u_lan', username: 'lan', displayName: 'Trần Thị Lan' }, kind: 'device', deviceId: 'd7f3a91c-52be-4e0a-9c11-3b8f0e2d7a44', deviceName: 'MacBook Pro', ip: '192.168.1.31', createdAt: now - 6 * day, lastSeenAt: now - 30_000, online: true },
  { id: 's_6', user: { id: 'u_lan', username: 'lan', displayName: 'Trần Thị Lan' }, kind: 'device', deviceId: '0b42c8e7-19d3-4f6a-a2e5-77c1d9f04b18', deviceName: 'MacBook Pro', ip: '192.168.1.60', createdAt: now - 20 * day, lastSeenAt: now - 2 * day, online: false },
  { id: 's_3', user: { id: 'u_minh', username: 'minh', displayName: 'Lê Văn Minh' }, kind: 'device', deviceId: '5e19b0d2-8c4a-4b7e-b3f1-c2a8e6d91f07', deviceName: 'DESKTOP-MINH', ip: '10.8.0.12', createdAt: now - 9 * day, lastSeenAt: now - 20_000, online: true },
  { id: 's_7', user: { id: 'u_minh', username: 'minh', displayName: 'Lê Văn Minh' }, kind: 'web', deviceId: '', deviceName: 'Edge · Windows', ip: '10.8.0.12', createdAt: now - 3 * hour, lastSeenAt: now - 3 * hour, online: false },
  { id: 's_4', user: { id: 'u_vy', username: 'vy.nguyen', displayName: 'Nguyễn Thảo Vy' }, kind: 'device', deviceId: 'a8c2f4e1-3d7b-4a9c-8e2f-1b5d7c9e3a60', deviceName: 'MacBook Pro', ip: '192.168.1.45', createdAt: now - 2 * day, lastSeenAt: now - 5 * hour, online: false },
  { id: 's_5', user: { id: 'u_hoa', username: 'hoa.pham', displayName: 'Phạm Thu Hoa' }, kind: 'web', deviceId: '', deviceName: 'Safari · iOS', ip: '113.161.4.7', createdAt: now - 3 * day, lastSeenAt: now - 3 * day, online: false },
];

const audit: AuditEntry[] = [];
{
  const lanMac = sessions[1];
  const sample: [string, string, string, Record<string, unknown> | null][] = [
    ['admin', 'login', 'Tài khoản nội bộ', { method: 'password' }],
    ['lan', 'message.send', conversations[0].name, null],
    ['minh', 'denied', 'call.message.send', { reason: 'Vai trò người xem' }],
    ['admin', 'grant.update', 'Nhóm Chăm sóc khách hàng', { role: 'agent' }],
    ['lan', 'call.reaction.add', conversations[3].name, null],
    ['', 'login.failed', 'tuan', { provider: 'local', reason: 'Tài khoản bị khóa' }],
    ['admin', 'user.create', 'vy.nguyen', { source: 'ldap:p_ldap', isAdmin: false }],
    ['lan', 'device.approve', 'K7QM-2XRT', { deviceName: lanMac.deviceName, deviceId: lanMac.deviceId, deviceIp: lanMac.ip, approved: true }],
    ['admin', 'provider.update', 'AD Công ty', null],
    ['hoa.pham', 'login', 'Google Workspace', { method: 'sso' }],
    ['admin', 'session.revoke', 'MacBook Pro', { userId: 'u_vy', deviceId: 'f19e0c3b-7a2d-4c8e-9b1f-5d3e7a9c2b84', kind: 'device' }],
    ['lan', 'logout', 'MacBook Pro', { kind: 'device', deviceId: sessions[2].deviceId }],
  ];
  for (let i = 0; i < 230; i++) {
    const [actor, action, target, detail] = sample[i % sample.length];
    const u = users.find((x) => x.username === actor);
    audit.push({
      id: 5000 - i,
      at: now - i * 37 * min - 3 * min,
      actor: u ? { userId: u.id, username: u.username } : null,
      action,
      target,
      detail,
      ip: i % 3 ? '192.168.1.' + (20 + (i % 40)) : '10.8.0.12',
    });
  }
}

const server: ServerInfo = {
  name: 'Compola Văn phòng',
  version: '0.1.0',
  publicUrl: '',
  account: { name: 'Shop Compola', avatar: '', phase: 'ready' },
  listen: { port: 39218, allowNetwork: true },
  addresses: [{ ip: '192.168.1.20', kind: 'lan' }, { ip: '10.8.0.1', kind: 'vpn' }],
};

const STORAGE_KEY = 'compola-admin-mock-user';
// `?mock=1&as=<username>` starts signed in (handy for screenshots).
let currentUserId: string | null = (() => {
  try {
    const as = new URLSearchParams(window.location.search).get('as');
    const u = as ? users.find((x) => x.username === as) : undefined;
    if (u) return u.id;
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
})();
function setCurrent(id: string | null) {
  currentUserId = id;
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

const ok = (body: unknown = { ok: true }): Res => ({ status: 200, body });
const err = (status: number, error: string): Res => ({ status, body: { error } });

function log(action: string, target: string, detail: Record<string, unknown> | null = null) {
  const u = users.find((x) => x.id === currentUserId);
  audit.unshift({ id: Number(audit[0]?.id ?? 5000) + 1, at: Date.now(), actor: u ? { userId: u.id, username: u.username } : null, action, target, detail, ip: '127.0.0.1' });
}

function meOf(u: User) {
  const session = sessions.find((x) => x.user?.id === u.id && x.kind === 'web') ?? null;
  if (u.isAdmin) return { user: u, session, access: { role: 'admin', scope: { all: true, conversations: [], labels: [] } } };
  const eff = effective(u.id, grants, groups);
  return { user: u, session, access: eff.role ? { role: eff.role, scope: eff.scope } : null };
}

function publicProviders() {
  return {
    serverName: server.name,
    local: true,
    ldap: providers.filter((p) => p.kind === 'ldap' && p.enabled).map((p) => ({ id: p.id, name: p.name })),
    oidc: providers.filter((p) => p.kind === 'oidc' && p.enabled).map((p) => ({ id: p.id, name: p.name })),
  };
}

function maskProvider(p: Provider): Provider {
  return JSON.parse(JSON.stringify(p));
}

function mergeSecret(prev: string | undefined, next: string | undefined) {
  if (next === '••••') return prev ?? '';
  return next ? '••••' : '';
}

const delay = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 200));

export async function handle(method: string, rawPath: string, body: unknown): Promise<Res> {
  await delay();
  const url = new URL(rawPath, 'http://mock');
  const path = url.pathname;
  const q = url.searchParams;
  const b = (body ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const seg = path.split('/').filter(Boolean); // ['api', 'admin', 'users', id, ...]
  const route = `${method} ${path}`;

  // Public
  if (route === 'GET /info') return ok({ app: 'compola-server', version: server.version });
  if (route === 'GET /api/auth/providers') return ok(publicProviders());
  if (route === 'POST /api/auth/login') {
    const u = users.find((x) => x.username.toLowerCase() === String(b.username ?? '').trim().toLowerCase());
    const expected = b.provider === 'local' ? 'local' : `ldap:${b.provider}`;
    if (!u || !b.password || u.source !== expected) {
      log('login.failed', String(b.username ?? ''), { provider: b.provider, reason: 'Sai mật khẩu' });
      return err(401, 'Sai tên đăng nhập hoặc mật khẩu.');
    }
    if (u.disabled) return err(403, 'Tài khoản đã bị khóa.');
    setCurrent(u.id);
    u.lastLoginAt = Date.now();
    log('login', b.provider === 'local' ? 'Tài khoản nội bộ' : providers.find((p) => p.id === b.provider)?.name ?? '', { method: 'password' });
    return ok({ user: u });
  }
  if (route === 'POST /__mock/oidc') {
    const u = users.find((x) => x.source === `oidc:${b.providerId}`) ?? users[1];
    setCurrent(u.id);
    u.lastLoginAt = Date.now();
    log('login', providers.find((p) => p.id === b.providerId)?.name ?? '', { method: 'sso' });
    return ok({ user: u });
  }
  if (route === 'POST /api/auth/logout') {
    log('logout', 'Trình duyệt', { kind: 'web' });
    setCurrent(null);
    return ok();
  }

  const me = users.find((x) => x.id === currentUserId && !x.disabled);
  if (!me) return err(401, 'Bạn cần đăng nhập.');

  if (route === 'GET /api/me') return ok(meOf(me));
  if (route === 'GET /api/me/sessions') return ok(sessions.filter((s) => s.user?.id === me.id));
  if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'me' && seg[2] === 'sessions') {
    const i = sessions.findIndex((s) => s.id === seg[3] && s.user?.id === me.id);
    if (i < 0) return err(404, 'Không tìm thấy phiên đăng nhập.');
    sessions.splice(i, 1);
    log('session.revoke', 'Thiết bị', { own: true });
    return ok();
  }
  if (route === 'GET /api/device/info') {
    const code = (q.get('code') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return err(404, 'Mã thiết bị không hợp lệ hoặc đã hết hạn.');
    return ok({ deviceName: 'MacBook Pro', deviceId: '3c9d7e21-6b4f-4a8d-91e3-f2b07c5a8d19', ip: '192.168.1.77', createdAt: Date.now() - 40_000 });
  }
  if (route === 'POST /api/device/approve') {
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(b.userCode).toUpperCase())) return err(404, 'Mã thiết bị không hợp lệ hoặc đã hết hạn.');
    if (b.approve && !me.isAdmin && !effective(me.id, grants, groups).role) return err(403, 'Tài khoản chưa được cấp quyền.');
    log('device.approve', String(b.userCode), { deviceName: 'MacBook Pro', deviceId: '3c9d7e21-6b4f-4a8d-91e3-f2b07c5a8d19', deviceIp: '192.168.1.77', approved: !!b.approve });
    return ok();
  }

  if (seg[0] !== 'api' || seg[1] !== 'admin') return err(404, 'Không tìm thấy.');
  if (!me.isAdmin) return err(403, 'Bạn không có quyền quản trị.');
  const [, , res, id, sub] = seg;

  switch (res) {
    case 'users': {
      if (method === 'GET' && !id) return ok(users);
      if (method === 'POST' && !id) {
        const username = String(b.username ?? '').trim();
        if (!username) return err(400, 'Thiếu tên đăng nhập.');
        if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return err(409, `Tên đăng nhập «${username}» đã có người dùng (không phân biệt hoa thường).`);
        const source = b.source || 'local';
        if (source === 'local' && !b.password) return err(400, 'Tài khoản nội bộ cần mật khẩu.');
        const u: User = { id: nid('u'), username, displayName: b.displayName || username, email: b.email || '', source, isAdmin: !!b.isAdmin, disabled: false, createdAt: Date.now(), lastLoginAt: null };
        users.push(u);
        log('user.create', username);
        return ok({ user: u });
      }
      const u = users.find((x) => x.id === id);
      if (!u) return err(404, 'Không tìm thấy người dùng.');
      if (method === 'PATCH') {
        if (u.id === me.id && (b.isAdmin === false || b.disabled === true)) return err(400, 'Không thể tự bỏ quyền quản trị hoặc khóa chính mình.');
        for (const k of ['displayName', 'email', 'isAdmin', 'disabled'] as const) if (k in b) (u as any)[k] = b[k]; // eslint-disable-line @typescript-eslint/no-explicit-any
        log('user.update', u.username);
        return ok({ user: u });
      }
      if (method === 'POST' && sub === 'password') {
        if (u.source !== 'local') return err(400, 'Chỉ đặt mật khẩu cho tài khoản nội bộ.');
        log('user.password', u.username);
        return ok();
      }
      if (method === 'DELETE') {
        if (u.id === me.id) return err(400, 'Không thể xóa chính mình.');
        users.splice(users.indexOf(u), 1);
        groups.forEach((g) => (g.members = g.members.filter((m) => m !== u.id)));
        for (let i = grants.length - 1; i >= 0; i--) if (grants[i].subject.type === 'user' && grants[i].subject.id === u.id) grants.splice(i, 1);
        log('user.delete', u.username);
        return ok();
      }
      break;
    }
    case 'groups': {
      if (method === 'GET' && !id) return ok(groups);
      if (method === 'POST' && !id) {
        if (!b.name) return err(400, 'Thiếu tên nhóm.');
        if (groups.some((g) => g.name === b.name)) return err(409, 'Tên nhóm đã tồn tại.');
        const g: Group = { id: nid('g'), name: b.name, description: b.description ?? '', source: 'local', members: [] };
        groups.push(g);
        log('group.create', g.name);
        return ok({ group: g });
      }
      const g = groups.find((x) => x.id === id);
      if (!g) return err(404, 'Không tìm thấy nhóm.');
      if (method === 'PATCH') {
        if ('name' in b) g.name = b.name;
        if ('description' in b) g.description = b.description;
        log('group.update', g.name);
        return ok({ group: g });
      }
      if (method === 'PUT' && sub === 'members') {
        g.members = (b.userIds ?? []).filter((x: string) => users.some((u) => u.id === x));
        log('group.members', g.name, { members: g.members.length });
        return ok({ group: g });
      }
      if (method === 'DELETE') {
        groups.splice(groups.indexOf(g), 1);
        for (let i = grants.length - 1; i >= 0; i--) if (grants[i].subject.type === 'group' && grants[i].subject.id === g.id) grants.splice(i, 1);
        log('group.delete', g.name);
        return ok();
      }
      break;
    }
    case 'grants': {
      if (method === 'GET' && !id) return ok(grants);
      if (method === 'POST' && !id) {
        const g: Grant = { id: nid('gr'), subject: b.subject, role: b.role, scope: b.scope, note: b.note ?? '', createdAt: Date.now() };
        grants.push(g);
        log('grant.create', g.subject.id);
        return ok({ grant: g });
      }
      const g = grants.find((x) => x.id === id);
      if (!g) return err(404, 'Không tìm thấy quyền.');
      if (method === 'PATCH') {
        Object.assign(g, b, { id: g.id, createdAt: g.createdAt });
        log('grant.update', g.subject.id);
        return ok({ grant: g });
      }
      if (method === 'DELETE') {
        grants.splice(grants.indexOf(g), 1);
        log('grant.delete', g.subject.id);
        return ok();
      }
      break;
    }
    case 'access': {
      const u = users.find((x) => x.id === id);
      if (!u) return err(404, 'Không tìm thấy người dùng.');
      if (u.isAdmin) return ok({ user: u, role: 'admin', scope: { all: true, conversations: [], labels: [] }, via: [{ admin: true }] });
      const eff = effective(u.id, grants, groups);
      if (!eff.role) return ok({ user: u, role: null, scope: null, via: [] });
      return ok({ role: eff.role, scope: eff.scope, via: eff.via.map((g) => ({ grantId: g.id, subject: g.subject, role: g.role })) });
    }
    case 'conversations':
      return ok({ conversations, labels });
    case 'providers': {
      if (method === 'GET' && !id) return ok(providers.map(maskProvider));
      if (method === 'POST' && !id) {
        const p = { id: nid('p'), kind: b.kind, name: b.name, enabled: !!b.enabled, config: { ...b.config } } as Provider;
        if (p.kind === 'ldap') p.config.bindPassword = mergeSecret('', p.config.bindPassword);
        else p.config.clientSecret = mergeSecret('', p.config.clientSecret);
        providers.push(p);
        log('provider.create', p.name);
        return ok({ provider: maskProvider(p) });
      }
      const p = providers.find((x) => x.id === id);
      if (!p) return err(404, 'Không tìm thấy nguồn đăng nhập.');
      if (method === 'POST' && sub === 'test') {
        if (p.kind === 'ldap') {
          if (b.username)
            return ok(
              b.password === 'sai'
                ? { ok: false, message: 'Bind thất bại: Invalid credentials (49).' }
                : { ok: true, message: `Đăng nhập thử thành công với ${b.username}.`, user: { username: b.username, displayName: 'Người Dùng Thử', email: `${b.username}@congty.local`, groups: ['Compola Admins', 'Sales'] } },
            );
          return ok({ ok: true, message: `Kết nối ${p.config.url} và bind bằng tài khoản dịch vụ thành công.` });
        }
        return ok(p.config.issuer ? { ok: true, message: `Đọc được cấu hình OpenID từ ${p.config.issuer}.` } : { ok: false, message: 'Không có Issuer: không kiểm tra tự động được với OAuth 2 thuần.' });
      }
      if (method === 'PATCH') {
        if ('name' in b) p.name = b.name;
        if ('enabled' in b) p.enabled = !!b.enabled;
        if (b.config) {
          const prev = p.config as unknown as Record<string, string>;
          const next = { ...b.config };
          if (p.kind === 'ldap') next.bindPassword = mergeSecret(prev.bindPassword, next.bindPassword);
          else next.clientSecret = mergeSecret(prev.clientSecret, next.clientSecret);
          p.config = next;
        }
        log('provider.update', p.name);
        return ok({ provider: maskProvider(p) });
      }
      if (method === 'DELETE') {
        providers.splice(providers.indexOf(p), 1);
        log('provider.delete', p.name);
        return ok();
      }
      break;
    }
    case 'sessions': {
      if (method === 'GET' && !id) return ok(sessions);
      if (method === 'DELETE') {
        const i = sessions.findIndex((s) => s.id === id);
        if (i < 0) return err(404, 'Không tìm thấy phiên đăng nhập.');
        log('session.revoke', sessions[i].deviceName, { userId: sessions[i].user?.id, deviceId: sessions[i].deviceId, kind: sessions[i].kind });
        sessions.splice(i, 1);
        return ok();
      }
      break;
    }
    case 'audit': {
      const limit = Number(q.get('limit') ?? 100);
      const before = q.get('before');
      const userId = q.get('userId');
      const action = q.get('action');
      const rows = audit.filter((e) => (!before || Number(e.id) < Number(before)) && (!userId || e.actor?.userId === userId) && (!action || e.action === action));
      return ok(rows.slice(0, limit));
    }
    case 'server': {
      if (method === 'GET') return ok(server);
      if (method === 'PATCH') {
        if (typeof b.name === 'string') server.name = b.name;
        if (typeof b.publicUrl === 'string') server.publicUrl = b.publicUrl;
        log('server.update', server.name);
        return ok(server);
      }
      break;
    }
  }
  return err(404, 'Không tìm thấy.');
}
