import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleUser,
  Monitor,
  Moon,
  Search,
  Sun,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorSmartphone,
  ScrollText,
  Settings,
  Lock,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { api, ApiError, isMock, setUnauthorizedHandler } from './api';
import { roleLabel, serverHealth } from './format';
import { CommandPalette, isMac, useCommandShortcut, type Command } from './command';
import { useInterval, useLoad } from './hooks';
import { navigate, useRoute, type Route } from './router';
import { toastError, useStore, type Theme } from './store';
import type { Me } from './types';
import { Avatar, Badge, ConfirmHost, cx, Empty, ErrorBox, Kbd, MenuButtons, Popover, Segmented, Spinner, StatusDot, Toasts } from './ui';
import { SignInPage } from './pages/SignIn';
import { DevicePage } from './pages/Device';
import { MePage } from './pages/Me';
import { DashboardPage } from './pages/Dashboard';
import { MembersPage } from './pages/Members';
import { GrantsPage } from './pages/Grants';
import { ProvidersPage } from './pages/Providers';
import { SessionsPage } from './pages/Sessions';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';

interface NavItem {
  path: string;
  /** Other routes that highlight this item (Users and Groups are tabs of one page). */
  also?: string[];
  label: string;
  icon: ReactNode;
  render: () => ReactNode;
}

// Settings-style navigation with labelled sections (Base44 "Members and groups").
const NAV_SECTIONS: { label: string | null; items: NavItem[] }[] = [
  { label: null, items: [{ path: '/', label: 'Tổng quan', icon: <LayoutDashboard size={16} />, render: () => <DashboardPage /> }] },
  {
    label: 'Truy cập & danh tính',
    items: [
      { path: '/users', also: ['/groups'], label: 'Người dùng & nhóm', icon: <Users size={16} />, render: () => <MembersPage /> },
      { path: '/grants', label: 'Phân quyền', icon: <ShieldCheck size={16} />, render: () => <GrantsPage /> },
      { path: '/providers', label: 'Đăng nhập', icon: <KeyRound size={16} />, render: () => <ProvidersPage /> },
    ],
  },
  {
    label: 'Bảo mật & giám sát',
    items: [
      { path: '/sessions', label: 'Thiết bị', icon: <MonitorSmartphone size={16} />, render: () => <SessionsPage /> },
      { path: '/audit', label: 'Nhật ký', icon: <ScrollText size={16} />, render: () => <AuditPage /> },
    ],
  },
  { label: 'Máy chủ', items: [{ path: '/settings', label: 'Cài đặt máy chủ', icon: <Settings size={16} />, render: () => <SettingsPage /> }] },
];
const matches = (n: NavItem, path: string) => n.path === path || !!n.also?.includes(path);

const ME_NAV: NavItem = { path: '/me', label: 'Tài khoản của tôi', icon: <CircleUser size={16} />, render: () => <MePage /> };

export function App() {
  const auth = useStore((s) => s.auth);
  const setAuth = useStore((s) => s.setAuth);
  const route = useRoute();
  const [fatal, setFatal] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    setFatal(null);
    try {
      const me = await api.me();
      setAuth({ status: 'signedIn', me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth({ status: 'signedOut' });
      else setFatal(e instanceof Error ? e.message : String(e));
    }
  }, [setAuth]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      useStore.getState().setAuth({ status: 'signedOut' });
    });
    void loadMe();
  }, [loadMe]);

  // Signed out → the sign-in route, remembering where we were.
  useEffect(() => {
    if (auth.status === 'signedOut' && route.path !== '/login') {
      navigate(`/login?next=${encodeURIComponent(route.full)}`, true);
    }
  }, [auth.status, route.path, route.full]);

  let content: ReactNode;
  if (fatal) {
    content = (
      <div className="center-screen">
        <div className="center-card">
          <h2>Không mở được trang quản trị</h2>
          <ErrorBox message={fatal} onRetry={loadMe} />
        </div>
      </div>
    );
  } else if (auth.status === 'loading') {
    content = (
      <div className="center-screen">
        <Spinner label="Đang tải…" />
      </div>
    );
  } else if (auth.status === 'signedOut' || route.path === '/login') {
    content = <SignInPage route={route} signedIn={auth.status === 'signedIn'} onSignedIn={loadMe} />;
  } else {
    content = <SignedIn me={auth.me} route={route} />;
  }

  return (
    <>
      {content}
      {isMock && <div className="mock-banner">Dữ liệu mẫu (mock)</div>}
      <ConfirmHost />
      <Toasts />
    </>
  );
}

function SignedIn({ me, route }: { me: Me; route: Route }) {
  const isAdmin = me.user.isAdmin;
  const [menuOpen, setMenuOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [route.path]);
  useCommandShortcut(() => setCmdOpen((v) => !v));
  // Server name / health for the sidebar block and footer (admins only: the endpoint is admin-only).
  const server = useLoad(() => (isAdmin ? api.server() : Promise.resolve(null)), [isAdmin]);
  useInterval(() => isAdmin && void server.reload(), 30000);

  let page: ReactNode;
  let title = 'Compola Server';
  let crumbs: string[] = [];
  if (route.path === '/device') {
    page = <DevicePage route={route} me={me} />;
    title = 'Đăng nhập thiết bị';
    crumbs = [title];
  } else if (route.path === '/me') {
    page = <MePage />;
    title = ME_NAV.label;
    crumbs = ['Cá nhân', title];
  } else if (!isAdmin) {
    page = route.path === '/' && me.access.role ? <MePage /> : <NoAdmin me={me} />;
  } else {
    const sec = NAV_SECTIONS.find((s) => s.items.some((n) => matches(n, route.path)));
    const item = sec?.items.find((n) => matches(n, route.path));
    if (item) {
      page = item.render();
      title = item.label;
      crumbs = sec?.label ? [sec.label, item.label] : [item.label];
    } else {
      page = (
        <Empty title="Không tìm thấy trang">
          <a href="#/">Về trang tổng quan</a>
        </Empty>
      );
    }
  }

  useEffect(() => {
    document.title = `${title} · Compola Server`;
  }, [title]);

  const commands = useMemo<Command[]>(
    () => [
      ...(isAdmin
        ? NAV_SECTIONS.flatMap((s) =>
            s.items.map((n) => ({ id: `page:${n.path}`, label: n.label, group: 'Trang', hint: s.label ?? undefined, icon: n.icon, run: () => navigate(n.path) })),
          )
        : []),
      { id: 'page:/me', label: ME_NAV.label, group: 'Trang', hint: 'Cá nhân', icon: ME_NAV.icon, run: () => navigate('/me') },
    ],
    [isAdmin],
  );

  const s = server.data;
  const health = s ? serverHealth(s) : null;
  const showSidebar = isAdmin;
  return (
    <div className={cx('shell', showSidebar && 'has-sidebar')}>
      {showSidebar && (
        <>
          <aside className={cx('sidebar', menuOpen && 'is-open')}>
            <div className="sidebar-brand">
              <span className="brand-mark">C</span>
              <span className="sidebar-brand-text">
                <strong>Compola Server</strong>
                <span className="truncate" title={s?.name}>
                  {s?.name ?? 'Bảng quản trị'}
                </span>
              </span>
              <button type="button" className="sidebar-close btn btn-ghost btn-icon btn-sm" aria-label="Đóng menu" onClick={() => setMenuOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <nav className="nav">
              {NAV_SECTIONS.map((sec) => (
                <div key={sec.label ?? 'main'} className="nav-section">
                  {sec.label && <div className="nav-section-label">{sec.label}</div>}
                  {sec.items.map((n) => (
                    <a key={n.path} href={`#${n.path}`} className={cx('nav-item', matches(n, route.path) && 'is-active')} aria-current={matches(n, route.path) ? 'page' : undefined}>
                      {n.icon}
                      <span>{n.label}</span>
                    </a>
                  ))}
                </div>
              ))}
              <div className="nav-section">
                <div className="nav-section-label">Cá nhân</div>
                <a href={`#${ME_NAV.path}`} className={cx('nav-item', route.path === ME_NAV.path && 'is-active')}>
                  {ME_NAV.icon}
                  <span>{ME_NAV.label}</span>
                </a>
              </div>
            </nav>
            {/* Twingate-style status line: is the server's Zalo session usable right now? */}
            <a className="sidebar-foot" href="#/" title={health?.label}>
              <StatusDot tone={health?.tone ?? 'neutral'} />
              <span className="truncate">{health?.label ?? 'Đang kiểm tra…'}</span>
              {s && <span className="tertiary nums">v{s.version}</span>}
            </a>
          </aside>
          {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}
        </>
      )}
      <div className="main">
        <TopBar me={me} crumbs={crumbs} onMenu={showSidebar ? () => setMenuOpen(true) : undefined} onSearch={() => setCmdOpen(true)} />
        <main className="content">{page}</main>
      </div>
      {cmdOpen && <CommandPalette pages={commands} isAdmin={isAdmin} onClose={() => setCmdOpen(false)} />}
    </div>
  );
}

const THEME_OPTIONS: { value: Theme; label: ReactNode }[] = [
  { value: 'system', label: <Monitor size={14} aria-label="Hệ thống" /> },
  { value: 'light', label: <Sun size={14} aria-label="Sáng" /> },
  { value: 'dark', label: <Moon size={14} aria-label="Tối" /> },
];

function TopBar({ me, crumbs, onMenu, onSearch }: { me: Me; crumbs: string[]; onMenu?: () => void; onSearch: () => void }) {
  const setAuth = useStore((s) => s.setAuth);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const logout = async () => {
    try {
      await api.logout();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        toastError(e);
        return;
      }
    }
    setAuth({ status: 'signedOut' });
    navigate('/login', true);
  };
  const name = me.user.displayName || me.user.username;
  return (
    <header className="topbar">
      {onMenu ? (
        <button type="button" className="btn btn-ghost btn-icon menu-button" aria-label="Mở menu" onClick={onMenu}>
          <Menu size={18} />
        </button>
      ) : (
        <a className="topbar-brand" href="#/">
          <span className="brand-mark">C</span>
          <strong>Compola Server</strong>
        </a>
      )}
      {crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Vị trí">
          {onMenu && <span className="hide-sm">Quản trị</span>}
          {crumbs.map((c, i) => (
            <Fragment key={c}>
              {(i > 0 || onMenu) && <ChevronRight size={14} className="hide-sm" />}
              <span className={cx(i === crumbs.length - 1 ? 'crumb-current' : 'hide-sm', 'truncate')}>{c}</span>
            </Fragment>
          ))}
        </nav>
      )}
      <div className="topbar-spacer" />
      <button type="button" className="cmdk-trigger hide-sm" onClick={onSearch}>
        <Search size={14} />
        <span>Tìm kiếm…</span>
        <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
      <button type="button" className="btn btn-ghost btn-icon show-sm" aria-label="Tìm kiếm" onClick={onSearch}>
        <Search size={17} />
      </button>
      <button
        ref={btn}
        type="button"
        className={cx('user-trigger', open && 'is-open')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Tài khoản: ${name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={name} size={26} />
        <ChevronDown size={14} />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="user-menu">
        <div className="menu-head">
          <Avatar name={name} size={34} />
          <div className="cell-text">
            <strong className="truncate">{name}</strong>
            <span className="secondary small truncate">
              @{me.user.username} · {roleLabel(me.user.isAdmin ? 'admin' : me.access.role)}
            </span>
          </div>
        </div>
        <MenuButtons
          onDone={() => setOpen(false)}
          items={[{ label: 'Tài khoản của tôi', icon: <CircleUser size={16} />, onSelect: () => navigate('/me') }]}
        />
        <div className="menu-label">Giao diện</div>
        <div className="menu-block">
          <Segmented value={theme} options={THEME_OPTIONS} onChange={setTheme} />
        </div>
        <div className="menu-sep" />
        <MenuButtons onDone={() => setOpen(false)} items={[{ label: 'Đăng xuất', icon: <LogOut size={16} />, onSelect: () => void logout() }]} />
      </Popover>
    </header>
  );
}

function NoAdmin({ me }: { me: Me }) {
  const hasAccess = !!me.access.role;
  return (
    <div className="narrow">
      <Empty icon={<Lock size={30} />} title="Bạn không có quyền quản trị">
        {hasAccess ? (
          <>
            Tài khoản <strong>{me.user.username}</strong> được dùng Compola với vai trò{' '}
            <Badge tone="accent">{roleLabel(me.access.role)}</Badge> nhưng không quản trị được máy chủ.
          </>
        ) : (
          <>
            Tài khoản <strong>{me.user.username}</strong> chưa được cấp quyền dùng tài khoản Zalo trên máy chủ này. Hãy
            nhờ quản trị viên cấp quyền cho bạn.
          </>
        )}
      </Empty>
      <div className="center-actions">
        <a className="btn btn-secondary" href="#/me">
          <CircleUser size={16} />
          <span>Tài khoản của tôi</span>
        </a>
      </div>
    </div>
  );
}
