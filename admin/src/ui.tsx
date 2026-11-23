// Small component kit of the admin console (styles in styles.css).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Copy, Globe, Loader2, Lock, MonitorSmartphone, MoreHorizontal, RefreshCw, Search, Users, X } from 'lucide-react';
import { ApiError } from './api';
import { initials, shortId, sourceInfo, type ActionTone } from './format';
import { toast, useStore } from './store';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-ghost';

export function Button({
  variant = 'secondary',
  size,
  icon,
  busy,
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm';
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', !children && 'btn-icon', className)}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy ? <Loader2 className="spin" size={16} /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, icon, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; variant?: ButtonVariant }) {
  const { variant = 'ghost', ...props } = rest;
  return (
    <button type="button" className={cx('btn', `btn-${variant}`, 'btn-sm', 'btn-icon')} title={label} aria-label={label} {...props}>
      {icon}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <Loader2 className="spin" size={22} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, dot }: { tone?: ActionTone | 'accent'; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cx('badge', `badge-${tone}`)}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

export function OnlineDot({ online }: { online: boolean }) {
  return <span className={cx('online-dot', online && 'is-online')} title={online ? 'Đang trực tuyến' : 'Ngoại tuyến'} />;
}

export function Avatar({ name, src, size = 32, group }: { name: string; src?: string | null; size?: number; group?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const hue = useMemo(() => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }, [name]);
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.38) } as React.CSSProperties;
  return (
    <span className="avatar" style={style}>
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar-fallback" style={{ background: `hsl(${hue} 55% 48%)` }}>
          {group ? <Users size={size * 0.5} /> : initials(name)}
        </span>
      )}
      {group && src && !failed && (
        <span className="avatar-group-mark">
          <Users size={9} />
        </span>
      )}
    </span>
  );
}

/** A labelled control. `group`: the children are a composite control (picker, chips), so no wrapping <label>. */
export function Field({ label, hint, children, error, group }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null; group?: boolean }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </Tag>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('toggle-row', disabled && 'is-disabled')}>
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'is-active')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Tìm kiếm…', autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  return (
    <div className="search">
      <Search size={16} />
      <input type="search" value={value} placeholder={placeholder} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button type="button" className="search-clear" aria-label="Xóa" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function PasswordInput({ value, onChange, placeholder, autoComplete = 'new-password', id }: { value: string; onChange: (v: string) => void; placeholder?: string; autoComplete?: string; id?: string }) {
  return <input id={id} type="password" className="input" value={value} placeholder={placeholder} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} />;
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  sheet,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** A side sheet (right edge) instead of a centred dialog: for long configuration forms. */
  sheet?: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, []);
  return (
    <div className={cx('modal-backdrop', sheet && 'is-sheet')} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide', sheet && 'modal-sheet')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p className="secondary">{subtitle}</p>}
          </div>
          <IconButton label="Đóng" icon={<X size={18} />} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** A modal whose body is a form: Enter submits, errors show inline. */
export function FormModal({
  title,
  subtitle,
  onClose,
  onSubmit,
  submitLabel = 'Lưu',
  children,
  wide,
  danger,
  extraFooter,
  sheet,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  submitLabel?: string;
  children: ReactNode;
  wide?: boolean;
  sheet?: boolean;
  danger?: boolean;
  extraFooter?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      wide={wide}
      sheet={sheet}
      footer={
        <>
          {extraFooter && <div className="modal-foot-extra">{extraFooter}</div>}
          <Button onClick={onClose}>Hủy</Button>
          <Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} busy={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        {children}
        {error && <ErrorBox message={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function ConfirmHost() {
  const req = useStore((s) => s.confirm);
  if (!req) return null;
  return (
    <Modal
      title={req.title}
      onClose={() => req.resolve(false)}
      footer={
        <>
          <Button onClick={() => req.resolve(false)}>Hủy</Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => req.resolve(true)} autoFocus>
            {req.confirmLabel ?? 'Đồng ý'}
          </Button>
        </>
      }
    >
      {req.message && <p className="confirm-message">{req.message}</p>}
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone === 'error' && 'toast-error')}>
          {t.tone === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <AlertTriangle size={16} />
      <span>{message}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={onRetry}>
          Thử lại
        </Button>
      )}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="secondary">{children}</div>}
    </div>
  );
}

export function Forbidden() {
  return (
    <Empty icon={<Lock size={28} />} title="Bạn không có quyền xem mục này">
      Hãy liên hệ quản trị viên máy chủ Compola nếu bạn cần quyền truy cập.
    </Empty>
  );
}

/** Loading / error states of a `useLoad` result; renders children once data is there. */
export function Loadable<T>({ state, children }: { state: { data: T | undefined; error: unknown; loading: boolean; reload: () => void }; children: (data: T) => ReactNode }) {
  if (state.error && (!state.data || (state.error instanceof ApiError && state.error.status === 403))) {
    if (state.error instanceof ApiError && state.error.status === 403) return <Forbidden />;
    if (state.error instanceof ApiError && state.error.status === 401) return <Spinner />;
    return <ErrorBox message={state.error instanceof Error ? state.error.message : String(state.error)} onRetry={state.reload} />;
  }
  if (state.data === undefined) return <Spinner label="Đang tải…" />;
  return <>{children(state.data)}</>;
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="secondary">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={cx(pad && 'card-body')}>{children}</div>
    </section>
  );
}

export function CopyField({ value }: { value: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('Đã sao chép');
    } catch {
      toast('Không sao chép được', 'error');
    }
  };
  return (
    <div className="copy-field">
      <code className="selectable">{value}</code>
      <IconButton label="Sao chép" icon={<Copy size={15} />} onClick={copy} />
    </div>
  );
}

export function LabelChip({ name, color, active, onClick }: { name: string; color: string; active?: boolean; onClick?: () => void }) {
  const style = { '--chip': color || '#8b96a7' } as React.CSSProperties;
  const content = (
    <>
      <span className="chip-dot" />
      {name}
      {active !== undefined && active && <Check size={13} />}
    </>
  );
  return onClick ? (
    <button type="button" className={cx('chip', active && 'is-active')} style={style} onClick={onClick} aria-pressed={active}>
      {content}
    </button>
  ) : (
    <span className={cx('chip', 'is-static')} style={style}>
      {content}
    </span>
  );
}

export interface PickItem {
  id: string;
  label: string;
  sub?: string;
  avatar?: string | null;
  group?: boolean;
  disabled?: boolean;
  search?: string;
}

/** Searchable multi-select list with checkboxes. */
export function MultiPicker({
  items,
  selected,
  onChange,
  placeholder,
  filters,
  emptyText = 'Không có kết quả',
  height = 280,
}: {
  items: PickItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  filters?: { label: string; test: (item: PickItem) => boolean }[];
  emptyText?: string;
  height?: number;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(-1);
  const [onlySelected, setOnlySelected] = useState(false);
  const sel = useMemo(() => new Set(selected), [selected]);
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const shown = useMemo(() => {
    const nq = norm(q.trim());
    return items.filter(
      (i) =>
        (!onlySelected || sel.has(i.id)) &&
        (filter < 0 || !filters || filters[filter].test(i)) &&
        (!nq || norm(`${i.label} ${i.sub ?? ''} ${i.search ?? ''}`).includes(nq)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q, filter, onlySelected, sel]);
  const toggle = (id: string) => onChange(sel.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const allShownSelected = shown.length > 0 && shown.every((i) => sel.has(i.id) || i.disabled);
  const toggleAllShown = () => {
    if (allShownSelected) {
      const ids = new Set(shown.map((i) => i.id));
      onChange(selected.filter((x) => !ids.has(x)));
    } else {
      const next = new Set(selected);
      shown.forEach((i) => !i.disabled && next.add(i.id));
      onChange([...next]);
    }
  };
  return (
    <div className="picker">
      <div className="picker-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={placeholder} />
        <div className="picker-filters">
          {filters && (
            <>
              <button type="button" className={cx('pill', filter < 0 && 'is-active')} onClick={() => setFilter(-1)}>
                Tất cả
              </button>
              {filters.map((f, i) => (
                <button key={f.label} type="button" className={cx('pill', filter === i && 'is-active')} onClick={() => setFilter(i)}>
                  {f.label}
                </button>
              ))}
            </>
          )}
          <button type="button" className={cx('pill', onlySelected && 'is-active')} onClick={() => setOnlySelected((v) => !v)}>
            Đã chọn ({selected.length})
          </button>
        </div>
      </div>
      <div className="picker-list" style={{ maxHeight: height }}>
        {shown.length > 1 && (
          <label className="picker-item picker-all">
            <input type="checkbox" checked={allShownSelected} onChange={toggleAllShown} />
            <span className="secondary">{allShownSelected ? 'Bỏ chọn' : 'Chọn'} {shown.length} mục đang hiện</span>
          </label>
        )}
        {shown.map((i) => (
          <label key={i.id} className={cx('picker-item', sel.has(i.id) && 'is-selected', i.disabled && 'is-disabled')}>
            <input type="checkbox" checked={sel.has(i.id)} disabled={i.disabled} onChange={() => toggle(i.id)} />
            <Avatar name={i.label} src={i.avatar} size={30} group={i.group} />
            <span className="picker-text">
              <span className="truncate">{i.label}</span>
              {i.sub && <span className="picker-sub truncate">{i.sub}</span>}
            </span>
          </label>
        ))}
        {!shown.length && <div className="picker-empty secondary">{emptyText}</div>}
      </div>
    </div>
  );
}

/** Searchable single select (for long lists: users, conversations). */
export function SinglePicker({ items, value, onChange, placeholder, height = 320 }: { items: PickItem[]; value: string | null; onChange: (id: string) => void; placeholder?: string; height?: number }) {
  const [q, setQ] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
  const nq = norm(q.trim());
  const shown = nq ? items.filter((i) => norm(`${i.label} ${i.sub ?? ''} ${i.search ?? ''}`).includes(nq)) : items;
  return (
    <div className="picker">
      <div className="picker-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={placeholder} />
      </div>
      <div className="picker-list" style={{ maxHeight: height }} role="listbox">
        {shown.map((i) => (
          <button
            key={i.id}
            type="button"
            role="option"
            aria-selected={value === i.id}
            className={cx('picker-item', value === i.id && 'is-selected')}
            onClick={() => onChange(i.id)}
          >
            <Avatar name={i.label} src={i.avatar} size={30} group={i.group} />
            <span className="picker-text">
              <span className="truncate">{i.label}</span>
              {i.sub && <span className="picker-sub truncate">{i.sub}</span>}
            </span>
            {value === i.id && <Check size={16} className="tint" />}
          </button>
        ))}
        {!shown.length && <div className="picker-empty secondary">Không có kết quả</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-top">
        <span className="secondary">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value nums">{value}</div>
      {sub && <div className="stat-sub secondary">{sub}</div>}
    </div>
  );
}

/** A person: avatar, display name, @username and (optionally) where the account comes from. Never a device. */
export function Person({
  user,
  source,
  providers,
  size = 32,
  extra,
}: {
  user: { username: string; displayName?: string } | null | undefined;
  source?: string;
  providers?: { id: string; name: string }[];
  size?: number;
  extra?: ReactNode;
}) {
  if (!user)
    return (
      <div className="cell-user">
        <Avatar name="?" size={size} />
        <span className="tertiary">Người dùng đã xóa</span>
      </div>
    );
  const name = user.displayName || user.username;
  const src = source !== undefined ? sourceInfo(source, providers) : null;
  return (
    <div className="cell-user">
      <Avatar name={name} size={size} />
      <div className="cell-text">
        <span className="truncate">
          {name}
          {extra}
        </span>
        <span className="secondary small truncate">
          @{user.username}
          {src && <Badge tone={src.kind === 'local' ? 'neutral' : 'info'}>{src.label}</Badge>}
        </span>
      </div>
    </div>
  );
}

/** A device id in short form; the full id is in the tooltip and selectable. */
export function DeviceId({ id }: { id: string | null | undefined }) {
  if (!id) return null;
  return (
    <code className="device-id selectable" title={`Mã thiết bị: ${id}`}>
      #{shortId(id)}
    </code>
  );
}

/** A device (or browser): icon, device name and short device id. Never a person. */
export function DeviceLabel({
  kind,
  deviceName,
  deviceId,
  online,
  sub,
}: {
  kind: 'web' | 'device' | string;
  deviceName: string;
  deviceId?: string;
  online?: boolean;
  sub?: ReactNode;
}) {
  const web = kind === 'web';
  return (
    <div className="cell-user">
      <span className="list-icon">
        {web ? <Globe size={17} /> : <MonitorSmartphone size={17} />}
        {online !== undefined && <OnlineDot online={online} />}
      </span>
      <div className="cell-text">
        <span className="truncate">
          {deviceName || (web ? 'Trình duyệt' : 'Thiết bị không tên')} {!web && <DeviceId id={deviceId} />}
        </span>
        {sub && <span className="secondary small truncate">{sub}</span>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Row "⋯" menu. The popover is position: fixed, so table scroll containers do not clip it. */
export function RowMenu({ items, label = 'Thao tác' }: { items: (MenuItem | false | null | undefined)[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = items.filter(Boolean) as MenuItem[];
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = pop.current?.offsetWidth ?? 200;
    const h = pop.current?.offsetHeight ?? 0;
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
    setPos({ top, left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && (pop.current?.contains(e.target) || btn.current?.contains(e.target))) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cx('btn', 'btn-ghost', 'btn-sm', 'btn-icon', open && 'is-pressed')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPos(null);
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <div ref={pop} className="menu" role="menu" style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}>
          {list.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={cx('menu-item', it.danger && 'is-danger')}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Underlined page tabs (links, so they are part of the hash route). */
export function Tabs({ items, active }: { items: { href: string; label: ReactNode; count?: number; key: string }[]; active: string }) {
  return (
    <nav className="tabs" role="tablist">
      {items.map((t) => (
        <a key={t.key} href={t.href} role="tab" aria-selected={active === t.key} className={cx('tab', active === t.key && 'is-active')}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}

/** Small status pill: "Đang bật" / "Đã tắt". */
export function StatusPill({ on, onLabel = 'Đang bật', offLabel = 'Đã tắt' }: { on: boolean; onLabel?: string; offLabel?: string }) {
  return (
    <Badge tone={on ? 'ok' : 'neutral'} dot>
      {on ? onLabel : offLabel}
    </Badge>
  );
}
