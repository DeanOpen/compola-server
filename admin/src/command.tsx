// ⌘K / Ctrl+K command palette: jump to a page or to a person (admins). No library.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CornerDownLeft, Monitor, Moon, Search, Sun, UserRound } from 'lucide-react';
import { api } from './api';
import { navigate } from './router';
import { useStore } from './store';
import type { User } from './types';
import { Avatar, cx, Kbd } from './ui';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  hint?: string;
  keywords?: string;
  run: () => void;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Opens on ⌘K / Ctrl+K from anywhere; `pages` are the navigation targets the signed-in user can open. */
export function useCommandShortcut(onOpen: () => void) {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function CommandPalette({ pages, isAdmin, onClose }: { pages: Command[]; isAdmin: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const setTheme = useStore((s) => s.setTheme);
  const listRef = useRef<HTMLDivElement>(null);

  // People are loaded when the palette opens (admins only; the list is small).
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    api.users().then(
      (u) => alive && setUsers(u),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  const commands = useMemo<Command[]>(() => {
    const people: Command[] = users.map((u) => ({
      id: `user:${u.id}`,
      label: u.displayName || u.username,
      hint: `@${u.username}`,
      group: 'Người dùng',
      icon: <Avatar name={u.displayName || u.username} size={20} />,
      keywords: `${u.username} ${u.email}`,
      run: () => navigate(`/users?q=${encodeURIComponent(u.username)}`),
    }));
    const theme: Command[] = [
      { id: 'theme:system', label: 'Giao diện: theo hệ thống', group: 'Giao diện', icon: <Monitor size={16} />, keywords: 'theme system', run: () => setTheme('system') },
      { id: 'theme:light', label: 'Giao diện: sáng', group: 'Giao diện', icon: <Sun size={16} />, keywords: 'theme light', run: () => setTheme('light') },
      { id: 'theme:dark', label: 'Giao diện: tối', group: 'Giao diện', icon: <Moon size={16} />, keywords: 'theme dark', run: () => setTheme('dark') },
    ];
    return [...pages, ...people, ...theme];
  }, [pages, users, setTheme]);

  const shown = useMemo(() => {
    const nq = norm(q.trim());
    if (!nq) return commands.filter((c) => c.group !== 'Người dùng');
    return commands.filter((c) => norm(`${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`).includes(nq));
  }, [commands, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div className="cmdk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Tìm kiếm nhanh" onKeyDown={onKey}>
        <div className="cmdk-input">
          <Search size={16} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trang, người dùng, lệnh…" aria-label="Tìm kiếm" />
          <Kbd>Esc</Kbd>
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox">
          {shown.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="cmdk-group">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={cx('cmdk-item', i === active && 'is-active')}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span className="cmdk-icon">{c.icon ?? <UserRound size={16} />}</span>
                  <span className="truncate">{c.label}</span>
                  {c.hint && <span className="cmdk-hint truncate">{c.hint}</span>}
                  {i === active && <CornerDownLeft size={14} className="cmdk-enter" />}
                </button>
              </div>
            );
          })}
          {!shown.length && <div className="cmdk-empty secondary">Không tìm thấy “{q}”</div>}
        </div>
        <div className="cmdk-foot">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> chọn
          </span>
          <span>
            <Kbd>↵</Kbd> mở
          </span>
          <span className="tertiary">{isMac ? '⌘K' : 'Ctrl K'} để mở ở bất kỳ đâu</span>
        </div>
      </div>
    </div>
  );
}
