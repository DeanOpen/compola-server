import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  CircleUser,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MonitorSmartphone,
  ScrollText,
  Settings,
  Lock,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { api, ApiError, isMock, setUnauthorizedHandler } from './api';
import { roleLabel } from './format';
import { navigate, useRoute, type Route } from './router';
import { toastError, useStore } from './store';
import type { Me } from './types';
import { Avatar, Badge, Button, ConfirmHost, cx, Empty, ErrorBox, Spinner, Toasts } from './ui';
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
import { ZaloPage } from './pages/Zalo';

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
  { label: null, items: [{ path: '/', label: 'Tổng quan', icon: <LayoutDashboard size={18} />, render: () => <DashboardPage /> }] },
  {
    label: 'Truy cập & danh tính',
    items: [
      { path: '/users', also: ['/groups'], label: 'Người dùng & nhóm', icon: <Users size={18} />, render: () => <MembersPage /> },
      { path: '/grants', label: 'Phân quyền', icon: <ShieldCheck size={18} />, render: () => <GrantsPage /> },
      { path: '/providers', label: 'Đăng nhập', icon: <KeyRound size={18} />, render: () => <ProvidersPage /> },
    ],
  },
  {
    label: 'Bảo mật & giám sát',
    items: [
      { path: '/sessions', label: 'Thiết bị', icon: <MonitorSmartphone size={18} />, render: () => <SessionsPage /> },
      { path: '/audit', label: 'Nhật ký', icon: <ScrollText size={18} />, render: () => <AuditPage /> },
    ],
  },
  {
    label: 'Máy chủ',
    items: [
      { path: '/zalo', label: 'Tài khoản Zalo', icon: <MessageCircle size={18} />, render: () => <ZaloPage /> },
      { path: '/settings', label: 'Cài đặt máy chủ', icon: <Settings size={18} />, render: () => <SettingsPage /> },
    ],
  },
];
const ADMIN_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
const matches = (n: NavItem, path: string) => n.path === path || !!n.also?.includes(path);

const ME_NAV: NavItem = { path: '/me', label: 'Tài khoản của tôi', icon: <CircleUser size={18} />, render: () => <MePage /> };

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
  useEffect(() => setMenuOpen(false), [route.path]);

  let page: ReactNode;
  let title = 'Compola Server';
  if (route.path === '/device') {
    page = <DevicePage route={route} me={me} />;
    title = 'Đăng nhập thiết bị';
  } else if (route.path === '/me') {
    page = <MePage />;
    title = ME_NAV.label;
  } else if (!isAdmin) {
    page = route.path === '/' && me.access.role ? <MePage /> : <NoAdmin me={me} />;
  } else {
    const item = ADMIN_NAV.find((n) => matches(n, route.path));
    if (item) {
      page = item.render();
      title = item.label;
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

  const showSidebar = isAdmin;
  return (
    <div className={cx('shell', showSidebar && 'has-sidebar')}>
      {showSidebar && (
        <>
          <aside className={cx('sidebar', menuOpen && 'is-open')}>
            <div className="sidebar-brand">
              <span className="brand-mark">C</span>
              <span>
                <strong>Compola</strong>
                <span className="secondary"> Server</span>
              </span>
              <button type="button" className="sidebar-close btn btn-ghost btn-icon btn-sm" aria-label="Đóng menu" onClick={() => setMenuOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <nav className="nav">
              {NAV_SECTIONS.map((sec) => (
                <div key={sec.label ?? 'main'} className="nav-section">
                  {sec.label && <div className="nav-section-label">{sec.label}</div>}
                  {sec.items.map((n) => (
                    <a key={n.path} href={`#${n.path}`} className={cx('nav-item', matches(n, route.path) && 'is-active')}>
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
          </aside>
          {menuOpen && <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />}
        </>
      )}
      <div className="main">
        <TopBar me={me} onMenu={showSidebar ? () => setMenuOpen(true) : undefined} />
        <main className="content">{page}</main>
      </div>
    </div>
  );
}

function TopBar({ me, onMenu }: { me: Me; onMenu?: () => void }) {
  const setAuth = useStore((s) => s.setAuth);
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    setBusy(true);
    try {
      await api.logout();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) {
        toastError(e);
        setBusy(false);
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
          <Menu size={20} />
        </button>
      ) : (
        <a className="topbar-brand" href="#/">
          <span className="brand-mark">C</span>
          <strong>Compola</strong>
        </a>
      )}
      <div className="topbar-spacer" />
      <a className="topbar-user" href="#/me" title="Tài khoản của tôi">
        <Avatar name={name} size={30} />
        <span className="topbar-user-text">
          <span className="truncate">{name}</span>
          <span className="topbar-role">{roleLabel(me.user.isAdmin ? 'admin' : me.access.role)}</span>
        </span>
      </a>
      <Button variant="ghost" icon={<LogOut size={16} />} busy={busy} onClick={logout} title="Đăng xuất">
        <span className="hide-sm">Đăng xuất</span>
      </Button>
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
