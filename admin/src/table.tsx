// Data table of the admin console: toolbar (search, filter chips, count), sortable sticky header, expandable rows and
// client-side paging. Layout follows enterprise consoles (Vanta "Event log", Snowflake "Users & roles").
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cx } from './ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Sort value; the column is sortable when given. */
  sort?: (row: T) => string | number;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  /** Hide below this viewport width (px), for secondary columns. */
  hideBelow?: 860 | 1100;
  className?: string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  toolbar,
  count,
  empty,
  loading,
  pageSize = 25,
  defaultSort = null,
  expand,
  rowClassName,
  onRowClick,
  footer,
  dense,
  bare,
  className,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Left side of the toolbar: search, filter chips. */
  toolbar?: ReactNode;
  /** Right side of the toolbar, e.g. "12 người dùng". */
  count?: ReactNode;
  empty?: ReactNode;
  loading?: boolean;
  /** 0: no paging (all rows). */
  pageSize?: number;
  defaultSort?: SortState;
  /** Row details shown under an expanded row (click to toggle). */
  expand?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | false | undefined;
  onRowClick?: (row: T) => void;
  /** Replaces the pager (e.g. "Tải thêm"). */
  footer?: ReactNode;
  dense?: boolean;
  /** No outer border (inside a Card). */
  bare?: boolean;
  className?: string;
}) {
  const [sort, setSort] = useState<SortState>(defaultSort);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    if (!rows) return [];
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    const dir = sort!.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'vi', { sensitivity: 'base', numeric: true }) * dir;
    });
  }, [rows, sort, columns]);

  const pages = pageSize > 0 ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  useEffect(() => {
    if (page >= pages) setPage(pages - 1);
  }, [page, pages]);
  const shown = pageSize > 0 ? sorted.slice(page * pageSize, (page + 1) * pageSize) : sorted;

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const toggleOpen = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const clickable = !!expand || !!onRowClick;
  const colCount = columns.length;

  return (
    <div className={cx('dt', bare && 'dt-bare', className)}>
      {(toolbar || count) && (
        <div className="dt-toolbar">
          <div className="dt-toolbar-main">{toolbar}</div>
          {count && <div className="dt-count secondary">{count}</div>}
        </div>
      )}
      <div className="dt-scroll">
        <table className={cx('table', dense && 'table-dense')}>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    style={{ width: c.width, textAlign: c.align }}
                    className={cx(c.hideBelow && `hide-below-${c.hideBelow}`, c.className)}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {c.sort ? (
                      <button type="button" className={cx('dt-sort', active && 'is-active')} onClick={() => toggleSort(c.key)}>
                        {c.header}
                        {active ? sort!.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ChevronsUpDown size={12} />}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && !rows
              ? Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} className="dt-skeleton">
                    {columns.map((c) => (
                      <td key={c.key} className={cx(c.hideBelow && `hide-below-${c.hideBelow}`)}>
                        <span className="skeleton" />
                      </td>
                    ))}
                  </tr>
                ))
              : shown.map((row) => {
                  const k = rowKey(row);
                  const isOpen = open.has(k);
                  return (
                    <Fragment key={k}>
                      <tr
                        className={cx(clickable && 'is-clickable', isOpen && 'is-open', rowClassName?.(row))}
                        onClick={
                          clickable
                            ? (e) => {
                                // Buttons, links and inputs inside the row keep their own behaviour.
                                if ((e.target as HTMLElement).closest('button, a, input, select, label, code.selectable')) return;
                                if (expand) toggleOpen(k);
                                else onRowClick?.(row);
                              }
                            : undefined
                        }
                      >
                        {columns.map((c) => (
                          <td key={c.key} style={{ textAlign: c.align }} className={cx(c.hideBelow && `hide-below-${c.hideBelow}`, c.className)}>
                            {c.render(row)}
                          </td>
                        ))}
                      </tr>
                      {expand && isOpen && (
                        <tr className="dt-expand">
                          <td colSpan={colCount}>{expand(row)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
          </tbody>
        </table>
        {rows && !rows.length && <div className="dt-empty">{empty ?? <span className="secondary">Không có dữ liệu</span>}</div>}
      </div>
      {footer ? (
        <div className="dt-foot">{footer}</div>
      ) : (
        pageSize > 0 &&
        sorted.length > pageSize && (
          <div className="dt-foot">
            <span className="secondary nums">
              {page * pageSize + 1}–{Math.min(sorted.length, (page + 1) * pageSize)} / {sorted.length}
            </span>
            <div className="dt-pager">
              <button type="button" className="btn btn-secondary btn-sm btn-icon" aria-label="Trang trước" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={15} />
              </button>
              <span className="secondary nums">
                Trang {page + 1} / {pages}
              </span>
              <button type="button" className="btn btn-secondary btn-sm btn-icon" aria-label="Trang sau" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
