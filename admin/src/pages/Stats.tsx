// Thống kê: KPI cards for the range, a per-day bar chart (sent messages, optionally stacked by person; plain SVG),
// and a sortable table grouped by person / Zalo account / conversation. Data: GET /api/admin/activity/stats.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, BarChart3, Clock, Download, MessageSquareText, MessagesSquare, Timer } from 'lucide-react';
import { api, type ActivityQuery } from '../api';
import { dayKey, formatDuration, frameRange, startOfDay, type Frame } from '../activity';
import { personText } from '../format';
import { useLoad } from '../hooks';
import { navigate } from '../router';
import { toastError } from '../store';
import type { ActivityGroupBy, ActivityStats, ActivityStatsRow, User } from '../types';
import { Button, cx, Empty, Loadable, PageHeader, Segmented, Stat, Toggle } from '../ui';

type Range = 'today' | '7d' | '30d' | 'month' | 'custom';
type TableGroup = Exclude<ActivityGroupBy, 'day'>;
type Metric = Exclude<keyof ActivityStatsRow, 'key' | 'label'>;

const DAY = 86_400_000;
const SERIES_COLORS = ['#0068ff', '#37b361', '#e0ac00', '#8e4ec6', '#e5484d', '#14a3b8'];
const OTHER_COLOR = '#8b96a7';
const MAX_STACK = 5;

const COLUMNS: { key: Metric; label: string; duration?: boolean; title?: string }[] = [
  { key: 'sent', label: 'Đã gửi' },
  { key: 'media', label: 'Ảnh / tệp' },
  { key: 'recalled', label: 'Thu hồi' },
  { key: 'reactions', label: 'Cảm xúc' },
  { key: 'reads', label: 'Đã đọc' },
  { key: 'opens', label: 'Mở' },
  { key: 'conversations', label: 'Hội thoại', title: 'Số hội thoại có thao tác với tin nhắn' },
  { key: 'responses', label: 'Phản hồi', title: 'Số lần gửi trả lời một tin chưa được trả lời' },
  { key: 'avgResponseMs', label: 'TB', duration: true, title: 'Thời gian phản hồi trung bình' },
  { key: 'medianResponseMs', label: 'Trung vị', duration: true, title: 'Thời gian phản hồi trung vị' },
  { key: 'p90ResponseMs', label: 'P90', duration: true, title: '90% lần phản hồi nhanh hơn mức này' },
];

export function StatsPage() {
  const [range, setRange] = useState<Range>('7d');
  const today = dayKey(new Date());
  const [custom, setCustom] = useState({ from: dayKey(new Date(Date.now() - 13 * DAY)), to: today });
  const [userId, setUserId] = useState('');
  const [account, setAccount] = useState('');
  const [groupBy, setGroupBy] = useState<TableGroup>('user');
  const [stack, setStack] = useState(false);

  const users = useLoad<User[]>(() => api.users().catch(() => []), []);
  const query: ActivityQuery = useMemo(
    () => ({ userId: userId || undefined, account: account || undefined, ...frameRange(range as Frame, custom) }),
    [userId, account, range, custom],
  );
  const accounts = useLoad(
    () =>
      api
        .activityStats({ groupBy: 'account', ...frameRange('30d') })
        .then((s) => s.rows.map((r) => r.key))
        .catch(() => [] as string[]),
    [],
  );
  const showAccounts = (accounts.data ?? []).some((a) => a !== '');

  const table = useLoad(() => api.activityStats({ ...query, groupBy }), [query, groupBy]);
  const daily = useLoad(() => loadDaily(query, stack && !userId), [query, stack, userId]);

  const exportCsv = () => api.exportActivityCsv({ ...query, groupBy }).catch(toastError);

  return (
    <div className="page">
      <PageHeader
        title="Thống kê"
        subtitle="Khối lượng công việc và tốc độ phản hồi của nhân viên trên tài khoản Zalo"
        actions={
          <Button icon={<Download size={16} />} onClick={exportCsv}>
            Xuất CSV
          </Button>
        }
      />
      <div className="filter-bar">
        <Segmented<Range>
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Hôm nay' },
            { value: '7d', label: '7 ngày' },
            { value: '30d', label: '30 ngày' },
            { value: 'month', label: 'Tháng này' },
            { value: 'custom', label: 'Tùy chọn' },
          ]}
        />
        {range === 'custom' && (
          <span className="date-range">
            <input
              type="date"
              className="input input-auto"
              value={custom.from}
              max={custom.to || today}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              aria-label="Từ ngày"
            />
            <span className="secondary">–</span>
            <input
              type="date"
              className="input input-auto"
              value={custom.to}
              min={custom.from}
              max={today}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              aria-label="Đến ngày"
            />
          </span>
        )}
        <select className="input input-auto" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Người">
          <option value="">Mọi người</option>
          {(users.data ?? [])
            .slice()
            .sort((a, b) => a.username.localeCompare(b.username))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {personText(u)}
              </option>
            ))}
        </select>
        {showAccounts && (
          <select className="input input-auto" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Tài khoản Zalo">
            <option value="">Mọi tài khoản Zalo</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a} value={a}>
                {a || 'Tài khoản mặc định'}
              </option>
            ))}
          </select>
        )}
      </div>

      <Loadable state={table}>
        {(s) => (
          <>
            <div className="stats stats-kpi">
              <Stat label="Tin đã gửi" icon={<MessageSquareText size={18} />} value={s.totals.sent.toLocaleString('vi-VN')} sub={`${s.totals.media} ảnh / tệp · ${s.totals.recalled} thu hồi`} />
              <Stat
                label="Hội thoại đã xử lý"
                icon={<MessagesSquare size={18} />}
                value={s.totals.conversations.toLocaleString('vi-VN')}
                sub={`${s.totals.opens} lần mở · ${s.totals.reads} lần đọc`}
              />
              <Stat label="Phản hồi trung bình" icon={<Clock size={18} />} value={formatDuration(s.totals.avgResponseMs)} sub={`${s.totals.responses} lần phản hồi`} />
              <Stat label="Phản hồi trung vị" icon={<Timer size={18} />} value={formatDuration(s.totals.medianResponseMs)} sub="Một nửa số lần nhanh hơn" />
              <Stat label="Phản hồi P90" icon={<Timer size={18} />} value={formatDuration(s.totals.p90ResponseMs)} sub="90% số lần nhanh hơn" />
            </div>

            <section className="card">
              <div className="card-head">
                <h3>Tin đã gửi theo ngày</h3>
                <div className="card-actions">
                  {!userId && <Toggle checked={stack} onChange={setStack} label="Chia theo người" />}
                </div>
              </div>
              <div className="card-body">
                <Loadable state={daily}>{(d) => <DailyChart data={d} />}</Loadable>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h3>Chi tiết</h3>
                <div className="card-actions">
                  <Segmented<TableGroup>
                    value={groupBy}
                    onChange={setGroupBy}
                    options={[
                      { value: 'user', label: 'Theo người' },
                      ...(showAccounts ? [{ value: 'account' as TableGroup, label: 'Theo tài khoản' }] : []),
                      { value: 'conversation', label: 'Theo hội thoại' },
                    ]}
                  />
                </div>
              </div>
              <StatsTable stats={s} groupBy={groupBy} users={users.data ?? []} />
            </section>
          </>
        )}
      </Loadable>
    </div>
  );
}

// ---- Data for the chart ----

interface Series {
  key: string;
  label: string;
  color: string;
  /** dayKey → sent */
  values: Map<string, number>;
}

interface Daily {
  days: string[];
  series: Series[];
}

function daysBetween(from: number, to: number): string[] {
  const out: string[] = [];
  for (let d = startOfDay(new Date(from)); d.getTime() <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(dayKey(d));
  return out;
}

async function loadDaily(query: ActivityQuery, stacked: boolean): Promise<Daily> {
  const total = await api.activityStats({ ...query, groupBy: 'day' });
  const keys = total.rows.map((r) => r.key).sort();
  const from = query.from ?? (keys[0] ? new Date(`${keys[0]}T00:00:00`).getTime() : Date.now());
  const days = daysBetween(from, query.to ?? Date.now());
  const all: Series = { key: 'all', label: 'Tin đã gửi', color: SERIES_COLORS[0], values: new Map(total.rows.map((r) => [r.key, r.sent])) };
  if (!stacked) return { days, series: [all] };

  // Top senders as their own series (one request each), everyone else (and the host) as "Khác".
  const byUser = await api.activityStats({ ...query, groupBy: 'user' });
  const top = byUser.rows
    .filter((r) => r.key !== 'host' && r.sent > 0)
    .sort((a, b) => b.sent - a.sent)
    .slice(0, MAX_STACK);
  const per = await Promise.all(top.map((r) => api.activityStats({ ...query, userId: r.key, groupBy: 'day' })));
  const series: Series[] = top.map((r, i) => ({
    key: r.key,
    label: r.label,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: new Map(per[i].rows.map((x) => [x.key, x.sent])),
  }));
  const other = new Map<string, number>();
  for (const d of days) {
    const rest = (all.values.get(d) ?? 0) - series.reduce((n, s) => n + (s.values.get(d) ?? 0), 0);
    if (rest > 0) other.set(d, rest);
  }
  if (other.size) series.push({ key: 'other', label: 'Khác', color: OTHER_COLOR, values: other });
  return { days, series };
}

// ---- Chart (plain SVG) ----

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A 1 / 2 / 5 × 10ⁿ step giving about four intervals, and the axis top (a multiple of it). */
function niceScale(v: number): { step: number; top: number } {
  const raw = Math.max(1, v) / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p);
  return { step, top: Math.max(step, Math.ceil(v / step) * step) };
}

function DailyChart({ data }: { data: Daily }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [data]);
  const totals = data.days.map((d) => data.series.reduce((n, s) => n + (s.values.get(d) ?? 0), 0));
  const { step, top: max } = niceScale(Math.max(0, ...totals));
  const H = 220;
  const pad = { l: 36, r: 8, t: 10, b: 26 };
  const W = Math.max(width, 280);
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const n = Math.max(1, data.days.length);
  const band = innerW / n;
  const barW = Math.max(2, Math.min(36, band * 0.7));
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(innerW / 46)));
  const fmtDay = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;

  if (!totals.some((t) => t > 0))
    return (
      <div ref={ref}>
        <Empty icon={<BarChart3 size={26} />} title="Chưa có tin nào được gửi trong khoảng này" />
      </div>
    );

  return (
    <div ref={ref} className="chart">
      {width > 0 && (
        <svg width={W} height={H} role="img" aria-label="Biểu đồ số tin đã gửi theo ngày">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.l - 6} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">
                {t}
              </text>
            </g>
          ))}
          {data.days.map((d, i) => {
            const x = pad.l + i * band + (band - barW) / 2;
            let acc = 0;
            return (
              <g key={d} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={cx('chart-col', hover === i && 'is-hover')}>
                <rect x={pad.l + i * band} y={pad.t} width={band} height={innerH} className="chart-hit" />
                {data.series.map((s) => {
                  const v = s.values.get(d) ?? 0;
                  if (!v) return null;
                  const top = y(acc + v);
                  const h = y(acc) - top;
                  acc += v;
                  return <rect key={s.key} x={x} y={top} width={barW} height={Math.max(1, h)} rx={Math.min(3, barW / 4)} fill={s.color} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={pad.l + i * band + band / 2} y={H - 8} className="chart-tick" textAnchor="middle">
                    {fmtDay(d)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(pad.l + hover * band + band / 2, 80), W - 80) }}>
          <strong>
            {fmtDay(data.days[hover])}: {totals[hover]} tin
          </strong>
          {data.series.length > 1 &&
            data.series
              .filter((s) => s.values.get(data.days[hover]))
              .map((s) => (
                <span key={s.key} className="chart-tip-row">
                  <span className="chip-dot" style={{ background: s.color }} /> {s.label}: {s.values.get(data.days[hover])}
                </span>
              ))}
        </div>
      )}
      {data.series.length > 1 && (
        <div className="chart-legend">
          {data.series.map((s) => (
            <span key={s.key}>
              <span className="chip-dot" style={{ background: s.color }} /> {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Table ----

function StatsTable({ stats, groupBy, users }: { stats: ActivityStats; groupBy: TableGroup; users: User[] }) {
  const [sort, setSort] = useState<{ key: Metric | 'label'; dir: 1 | -1 }>({ key: 'sent', dir: -1 });
  const userById = new Map(users.map((u) => [u.id, u]));
  const rows = [...stats.rows].sort((a, b) => {
    if (sort.key === 'label') return sort.dir * a.label.localeCompare(b.label);
    const av = a[sort.key] ?? -1;
    const bv = b[sort.key] ?? -1;
    return sort.dir * ((av as number) - (bv as number));
  });
  const toggle = (key: Metric | 'label') => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'label' ? 1 : -1 }));
  const mark = (key: Metric | 'label') => (sort.key === key ? sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} className="tertiary" />);
  const cell = (r: Pick<ActivityStatsRow, Metric>, c: (typeof COLUMNS)[number]) => {
    const v = r[c.key];
    return c.duration ? formatDuration(v) : v === null || v === undefined ? '—' : v.toLocaleString('vi-VN');
  };
  const label = (r: ActivityStatsRow) => {
    if (groupBy === 'user') {
      if (r.key === 'host') return <span>Chủ máy (trên máy chủ)</span>;
      const u = userById.get(r.key);
      return (
        <button type="button" className="link" onClick={() => navigate(`/activity?userId=${encodeURIComponent(r.key)}`)} title="Xem hoạt động">
          {u ? personText(u) : r.label}
        </button>
      );
    }
    if (groupBy === 'account') return <span>{r.label || 'Tài khoản mặc định'}</span>;
    return <span>«{r.label || r.key}»</span>;
  };
  const first = groupBy === 'user' ? 'Người' : groupBy === 'account' ? 'Tài khoản Zalo' : 'Hội thoại';

  if (!rows.length) return <div className="card-body secondary">Chưa có hoạt động trong khoảng này.</div>;
  return (
    <div className="table-scroll">
      <table className="stats-table">
        <thead>
          <tr>
            <th>
              <button type="button" className="th-sort" onClick={() => toggle('label')}>
                {first} {mark('label')}
              </button>
            </th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="num" title={c.title}>
                <button type="button" className="th-sort" onClick={() => toggle(c.key)}>
                  {c.label} {mark(c.key)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="stats-label">{label(r)}</td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="num nums">
                  {cell(r, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Tổng</td>
            {COLUMNS.map((c) => (
              <td key={c.key} className="num nums">
                {cell(stats.totals, c)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
