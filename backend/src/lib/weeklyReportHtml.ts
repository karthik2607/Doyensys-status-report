import { WEEKLY_REPORT_SHELL } from '../assets/weeklyReportShell';
import {
  WeeklyReportData, ReportTicket, Track, TRACKS, WORKSTREAMS, REPORT_CATEGORIES,
  ActivityRow, SimpleRow, WeeklyCountRow, TicketSection, STATUS_ABBR,
  countOpenTickets, openFromCounts,
  startOfReportWeek, endOfReportWeek, addDays, utcDay, sameWindow,
  monthKeyOf, monthLabel, shiftMonth,
} from './weeklyReportModel';

// ===========================================================================
// WEEKLY STATUS REPORT — rendering
//
// The customer's own report is the template. Rather than laying out a new
// document, this takes that file and swaps data into its sections, so the
// nav, hero, typography, colours, icon sprite and animations all come
// through untouched and the output is the same document with this week's
// numbers in it.
//
// Everything here therefore emits the exact class names that file uses
// (snap-card, update-panel st-closed, trend-card, stat-strip …). Changing a
// class here without changing the shell will silently lose its styling.
// ===========================================================================

const RECEIVED = '#3A6FB0';   // the blue the source report uses for "received"
const RESOLVED = '#E8590C';   // and the orange for "resolved"
const CARRY = '#2D9A8C';      // teal for carry-forward

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The source report writes dates as "Sep 30" / "Oct 06" — month first. The
// en-GB locale gives "30 Sept", so the order is set explicitly to match.
function fmtDay(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
}
function fmtLong(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function inRange(d: Date | null, a: Date | null, b: Date | null): boolean {
  return !!(d && a && b && d.getTime() >= a.getTime() && d.getTime() <= b.getTime());
}

// ---------------------------------------------------------------------------
// Section surgery on the shell
// ---------------------------------------------------------------------------

/** Replaces everything between a section's opening tag and its closing tag.
 * Sections in the shell are never nested, so the first following </section>
 * is always the right one. */
function replaceSectionBody(html: string, id: string, inner: string): string {
  const open = new RegExp(`<section[^>]*id="${id}"[^>]*>`);
  const m = open.exec(html);
  if (!m) return html;
  const start = m.index + m[0].length;
  const end = html.indexOf('</section>', start);
  if (end < 0) return html;
  return html.slice(0, start) + inner + html.slice(end);
}

/** Drops a whole section — used when a week has no content for it. */
function removeSection(html: string, id: string): string {
  const open = new RegExp(`<section[^>]*id="${id}"[^>]*>`);
  const m = open.exec(html);
  if (!m) return html;
  const end = html.indexOf('</section>', m.index);
  if (end < 0) return html;
  return html.slice(0, m.index) + html.slice(end + '</section>'.length);
}

/** Removes a dropped section's entry from the sticky nav so it doesn't link
 * to an anchor that is no longer in the document. */
function removeNavLink(html: string, id: string): string {
  return html.replace(new RegExp(`\\s*<li><a href="#${id}"[^>]*>[^<]*</a></li>`), '');
}

const wrap = (inner: string) => `\n  <div class="wrap">\n${inner}\n  </div>\n`;

// ---------------------------------------------------------------------------
// Charts — same geometry and palette as the source report
// ---------------------------------------------------------------------------

type Val = number | null;

/** A tidy axis step: the smallest 1/2/5×10ⁿ that splits `max` into three. */
function niceStep(max: number): number {
  const raw = Math.max(1, max) / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const k of [1, 2, 5, 10]) if (k * pow >= raw) return Math.max(1, k * pow);
  return Math.max(1, Math.ceil(raw));
}

function yGrid(padL: number, right: number, step: number, y: (v: number) => number): string {
  return [0, 1, 2, 3].map((k) => {
    const v = step * k, gy = y(v);
    return `<line x1="${padL}" x2="${right}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${k === 0 ? '#C9CCD2' : '#ECEDEF'}" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${gy.toFixed(1)}" dy="3.5" text-anchor="end" font-size="11" fill="#9AA0AC">${v}</text>`;
  }).join('');
}

/** Builds a path through the non-empty points. An empty value (null) breaks
 * the line rather than dropping it to zero. */
function gappedPath(values: Val[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '', pen = false;
  values.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

/**
 * Grouped bar chart — "Project Hours – by Track". One group per track, one bar
 * per month. A month with no figure (null) draws no bar and no label; a typed
 * zero draws a "0" so it reads as a real zero.
 */
function hoursBars(groups: string[], series: { name: string; color: string; values: Val[] }[]): string {
  const W = 560, H = 280, padL = 44, padR = 14, padT = 26, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = Math.max(1, groups.length);
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const step = niceStep(max);
  const niceMax = step * 3;
  const bandW = plotW / n;
  const gap = 3;
  const barW = Math.max(6, Math.min(30, (bandW - 24) / Math.max(1, series.length) - gap));
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const cols = groups.map((g, gi) => {
    const cx = padL + bandW * gi + bandW / 2;
    const left = cx - (series.length * (barW + gap) - gap) / 2;
    const bars = series.map((s, si) => {
      const v = s.values[gi];
      if (v === null || v === undefined) return '';
      const x = left + si * (barW + gap);
      return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - y(v)).toFixed(1)}" rx="3" fill="${s.color}"><title>${esc(s.name)} — ${esc(g)}: ${v} hrs</title></rect>`
        + `<text x="${(x + barW / 2).toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#1B1F27">${v}</text>`;
    }).join('');
    return bars + `<text x="${cx.toFixed(1)}" y="${H - 20}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#51565F">${esc(g)}</text>`;
  }).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" font-family="Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif">${yGrid(padL, W - padR, step, y)}${cols}</svg>`;
}

/**
 * Multi-series line chart — "Received vs Closed". Each week sits in the centre
 * of its band, with a dot, a hover title and the value beside the point. Where
 * two series meet at a week, the higher value is labelled above its dot and
 * the lower one below, so the numbers never sit on top of each other. An empty
 * week (null) gets no dot and breaks the line.
 */
function trendLines(labels: string[], series: { name: string; color: string; values: Val[] }[]): string {
  const W = 560, H = 260, padL = 40, padR = 18, padT = 26, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = labels.length;
  if (!n) return '';
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const step = Math.max(1, Math.ceil(max / 3));
  const niceMax = step * 3;
  const bandW = plotW / n;
  const x = (i: number) => padL + bandW * i + bandW / 2;
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const labs = labels.map((lab, i) =>
    `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="middle" font-size="11" fill="#6B7078">${esc(lab)}</text>`).join('');

  const paths = series.map((s) =>
    `<path d="${gappedPath(s.values, x, y)}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

  const dots = series.map((s) => s.values.map((v, i) => v === null ? '' :
    `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2"><title>${esc(s.name)} — ${esc(labels[i])}: ${v}</title></circle>`).join('')).join('');

  const vals = series.map((s, si) => s.values.map((v, i) => {
    if (v === null) return '';
    // Above the dot unless another series is higher at this week (ties: the
    // first series goes above, the rest below).
    const below = series.some((o, oi) => {
      const ov = o.values[i];
      return oi !== si && ov !== null && (ov > v || (ov === v && oi < si));
    });
    const ty = below ? y(v) + 18 : y(v) - 10;
    return `<text x="${x(i).toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#1B1F27" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">${v}</text>`;
  }).join('')).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" font-family="Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif">${yGrid(padL, W - padR, step, y)}${labs}${paths}${dots}${vals}</svg>`;
}

/** Single-series line chart with a soft fill — "Carry Forward". An empty
 * week (null) gets no dot and breaks the line. */
function trendLine(labels: string[], values: Val[], color: string): string {
  const W = 560, H = 260, padL = 40, padR = 18, padT = 26, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = labels.length;
  if (!n) return '';
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const step = Math.max(1, Math.ceil(max / 3));
  const niceMax = step * 3;
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;
  const base = (padT + plotH).toFixed(1);

  const path = gappedPath(values, x, y);
  // One filled area per unbroken run of values.
  const runs: number[][] = [];
  values.forEach((v, i) => {
    if (v === null) return;
    if (i > 0 && values[i - 1] !== null && runs.length) runs[runs.length - 1].push(i);
    else runs.push([i]);
  });
  const gid = 'cf' + color.replace('#', '');
  const areas = runs.map((r) => {
    const top = r.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`).join(' ');
    return `<path d="${top} L${x(r[r.length - 1]).toFixed(1)},${base} L${x(r[0]).toFixed(1)},${base} Z" fill="url(#${gid})"/>`;
  }).join('');
  const dots = values.map((v, i) => v === null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="2"><title>Carry forward — ${esc(labels[i])}: ${v}</title></circle>`).join('');
  const vals = values.map((v, i) => v === null ? '' : `<text x="${x(i).toFixed(1)}" y="${(y(v) - 10).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#1B1F27" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">${v}</text>`).join('');
  const labs = labels.map((lab, i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="${anchor}" font-size="11" fill="#6B7078">${esc(lab)}</text>`;
  }).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" font-family="Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${yGrid(padL, W - padR, step, y)}${areas}<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${vals}${labs}</svg>`;
}

/** Sum of the values that are present; null when none are. An empty cell is
 * not a zero, so it neither counts nor turns a blank total into "0". */
function sumOrNull(vals: Val[]): Val {
  const present = vals.filter((v): v is number => v !== null && v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}

/** Table cell text for a value that may be empty. */
const show = (v: Val | undefined) => (v === null || v === undefined ? '' : String(v));

// ---------------------------------------------------------------------------
// Panels (the update-panel pattern from the source report)
// ---------------------------------------------------------------------------

/** Renders a list where a row whose `parent` matches an earlier row's title
 * becomes a nested <ul class="sub-list"> under it — the indented bullets in
 * the source report. */
function bulletList(rows: { text: string; parent?: string }[]): string {
  const k = (s: string) => s.trim().toLowerCase();
  const texts = new Set(rows.filter((r) => !r.parent).map((r) => k(r.text)));
  // A sub-bullet whose parent isn't in this panel is shown as a bullet of its
  // own rather than disappearing.
  const tops = rows.filter((r) => !r.parent || !texts.has(k(r.parent)));
  return `<ul class="update-list">${tops.map((t) => {
    if (t.parent) return `<li>${esc(t.text)}</li>`;
    const kids = rows.filter((r) => r.parent && k(r.parent) === k(t.text));
    const sub = kids.length ? `<ul class="sub-list">${kids.map((k) => `<li>${esc(k.text)}</li>`).join('')}</ul>` : '';
    return `<li>${esc(t.text)}${sub}</li>`;
  }).join('')}</ul>`;
}

function panel(variant: string, icon: string, title: string, sub: string, body: string): string {
  return `<div class="update-panel ${variant} reveal"><div class="panel-hdr"><div class="icon-dot"><svg><use href="#${icon}"/></svg></div><div><h3>${esc(title)}</h3><div class="panel-sub">${esc(sub)}</div></div></div>${body}</div>`;
}

const SECTION_META: Record<string, { variant: string; icon: string; sub: string }> = {
  'Updates': { variant: 'upd', icon: 'i-checklist', sub: 'Work completed & in progress' },
  'Recommendations': { variant: 'opp', icon: 'i-handshake', sub: 'Items needing review or a decision' },
  'Closed': { variant: 'st-closed', icon: 'i-checklist', sub: 'Completed this week' },
  'WIP': { variant: 'st-wip', icon: 'i-checklist', sub: 'Work in progress' },
  'On-Hold': { variant: 'st-onhold', icon: 'i-checklist', sub: 'Paused or pending user testing' },
  'Others': { variant: 'st-others', icon: 'i-checklist', sub: 'Other items this week' },
};
const SECTION_TITLE: Record<string, string> = {
  'Recommendations': 'Recommendations / Decision points',
  'On-Hold': 'On-Hold / Awaiting User Testing',
};

function activityPanels(rows: ActivityRow[], order: string[]): string {
  return order.map((sec) => {
    const items = rows.filter((r) => r.section === sec);
    if (!items.length) return '';
    const meta = SECTION_META[sec] ?? { variant: 'st-others', icon: 'i-checklist', sub: '' };
    return panel(meta.variant, meta.icon, SECTION_TITLE[sec] ?? sec, meta.sub,
      bulletList(items.map((i) => ({ text: i.detail, parent: i.parent }))));
  }).join('');
}

/** The source report uses two shapes for these list sections: Value
 * Additions and Action Items carry a panel header, while Projects and Help
 * Needed are headless panels with the extra `help-panel` class. Both sit in
 * a `.val-wrap`, not the `.update-cols` grid the track sections use.
 *
 * Rows sharing the same title are grouped: the title becomes the top bullet
 * and each row's detail becomes an indented sub-bullet beneath it. That is
 * how the source report reads ("Data Archive & Purging" with three dated
 * items under it), and it means the spreadsheet just repeats the project
 * name down the rows rather than needing a separate nesting column.
 */
function simplePanel(title: string, sub: string, rows: SimpleRow[], opts?: { headless?: boolean }): string {
  if (!rows.length) return '';

  const suffix = (r: SimpleRow) =>
    (r.owner && r.owner !== '—' ? ` (${r.owner})` : '')
    + (r.due ? ` · due ${r.due}` : '')
    + (r.status && r.status !== '—' ? ` · ${r.status}` : '');

  const order: string[] = [];
  const groups = new Map<string, SimpleRow[]>();
  for (const r of rows) {
    const key = r.title || '';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(r);
  }

  const items: { text: string; parent?: string }[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const withDetail = group.filter((r) => r.detail && r.detail !== '—' && r.detail !== key);
    if (!key) {
      // No title at all — the detail is the whole bullet.
      for (const r of group) items.push({ text: r.detail + suffix(r) });
      continue;
    }
    if (withDetail.length === 0) {
      // Title only: one flat bullet, carrying any owner/due/status.
      for (const r of group) items.push({ text: key + suffix(r) });
      continue;
    }
    items.push({ text: key });
    for (const r of withDetail) items.push({ text: r.detail + suffix(r), parent: key });
  }

  const list = bulletList(items);
  if (opts?.headless) return `<div class="update-panel st-key help-panel reveal">${list}</div>`;
  return panel('st-key', 'i-checklist', title, sub, list);
}

// ---------------------------------------------------------------------------

interface TrackStats { open: number | null; received: number | null; resolved: number | null; carry: number | null; }

/** Looks up the typed Weekly Counts row for one track in one window. */
function countRow(counts: WeeklyCountRow[], win: { start: Date; end: Date }, track: Track): WeeklyCountRow | undefined {
  return counts.find((c) => c.track === track && sameWindow({ start: c.weekStart, end: c.weekEnd }, win));
}

/** Looks up the Tickets-sheet section whose banner dates are this window. */
function sectionFor(sections: TicketSection[], win: { start: Date; end: Date }): TicketSection | undefined {
  return sections.find((s) => s.start && s.end && sameWindow({ start: s.start, end: s.end }, win));
}

/**
 * Where a week's numbers come from.
 *
 * A week is supplied in exactly one of two ways, and the week itself decides
 * which:
 *
 *   • a SECTION on the Tickets sheet — the week's own ticket rows, with its
 *     carry-forward typed on the section banner;
 *   • a ROW on the Weekly Counts sheet — every figure typed, for the older
 *     weeks where no ticket-level export exists.
 *
 * Keeping them separate is the point. The Tickets sheet holds older still-open
 * tickets as backlog, so date-filtering the whole sheet for a past week would
 * publish a partial week as though it were complete. A section says which
 * tickets are that week's; a counts row says there are none to find.
 */
interface WeekSource {
  /** The tickets filed under this week, or all tickets when the sheet has no
   * sections (an older file) and the week has to be found by date. */
  tickets: ReportTicket[];
  /** Set when the week is supplied by a section — its tickets are definitive. */
  section?: TicketSection;
  /** Set when the week is supplied by typed counts. */
  row?: WeeklyCountRow;
}

/**
 * The four numbers in the Weekly Tickets Summary, for one track.
 *
 * Carry-forward is never derived under any circumstances. When nobody typed
 * it, the cell is blank and the generator says so, because a published figure
 * that quietly disagrees with its own arithmetic is worse than one the team
 * chose on purpose.
 */
function statsFor(
  tickets: ReportTicket[],
  from: Date | null,
  to: Date | null,
  row: WeeklyCountRow | undefined,
): TrackStats {
  // A typed Weekly Counts row is taken exactly as typed: an empty cell stays
  // empty, it is not filled in by counting tickets and it is not a zero.
  const received = row ? row.received : tickets.filter((t) => inRange(t.openDate, from, to)).length;
  const resolved = row ? row.closed : tickets.filter((t) => inRange(t.closedDate, from, to)).length;
  // Open tickets = WIP + Open + AUC + AUR + AM + Hold: a headcount by current
  // status (see countOpenTickets). A counts-only week has no ticket rows to
  // count, so the same six figures typed on its Weekly Counts row are added up
  // instead. Carry-forward, below, is NOT derived from this — it is typed.
  const open = row ? openFromCounts(row) : countOpenTickets(tickets);
  return { open, received, resolved, carry: row?.carryForward ?? null };
}

export interface TrendWindow { label: string; start: Date; end: Date; }

/**
 * The windows the trend charts run over: the eight most recent, newest last.
 *
 * Every window comes from dates somebody typed — a section banner on the
 * Tickets sheet, a Week Start / Week End pair on the Weekly Counts sheet, or
 * the week the report itself is being generated for. Nothing is invented by
 * stepping back seven days at a time, so a week shortened by a holiday charts
 * exactly as it was entered, and a week nobody entered simply isn't on the
 * chart rather than appearing as a false zero.
 */
function trendWindows(data: WeeklyReportData, from: Date | null, to: Date | null, weeks = 8): TrendWindow[] {
  const seen = new Map<string, { start: Date; end: Date }>();
  const add = (start: Date, end: Date) => {
    const key = `${start.getTime()}:${end.getTime()}`;
    if (!seen.has(key)) seen.set(key, { start, end });
  };

  for (const s of data.ticketSections) if (s.start && s.end) add(utcDay(s.start), utcDay(s.end));
  for (const c of data.weeklyCounts) add(c.weekStart, c.weekEnd);

  // The reported week belongs on the chart whether or not anyone typed a
  // counts row for it — its bars come from the tickets.
  if (from && to) add(utcDay(from), utcDay(to));
  else if (data.tickets.length) {
    const ts = data.tickets.flatMap((t) => [t.openDate, t.closedDate])
      .filter(Boolean).map((d) => (d as Date).getTime());
    if (ts.length) {
      const anchor = new Date(Math.max(...ts));
      add(startOfReportWeek(anchor), endOfReportWeek(anchor));
    }
  }

  const ordered = [...seen.values()].sort((a, b) => a.start.getTime() - b.start.getTime()).slice(-weeks);
  // Label each week by its end date (the Tuesday), not its start.
  return ordered.map((w) => ({ label: fmtDay(w.end), start: w.start, end: w.end }));
}

// ---------------------------------------------------------------------------

export function renderWeeklyReportHtml(data: WeeklyReportData): string {
  const { info, tickets } = data;
  const from = info.periodStart, to = info.periodEnd;
  let html = WEEKLY_REPORT_SHELL;

  // ------------------------------------------------------------------ title
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(info.customer || 'Doyensys')} — ${esc(info.reportTitle)}</title>`);

  // ------------------------------------------------------------------- hero
  const periodLabel = from && to ? `${fmtDay(from)}-${fmtDay(to)}` : '—';
  const meetingDay = info.meetingDate
    ? info.meetingDate.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : '—';
  const meetingYear = info.meetingDate ? info.meetingDate.getFullYear() : '';
  const cadence = info.meetingDate
    ? info.meetingDate.toLocaleDateString('en-US', { month: 'long', day: '2-digit' }).replace(/^(\w+)\s(\d+)$/, '$1, $2')
    : '';

  const statStrip = `<div class="stat-strip wrap" style="--cols:5">`
    + `<div class="stat"><div class="num">Scope</div><div class="label">${esc(info.scope)}</div></div>`
    + `<div class="stat"><div class="num">Reporting Period</div><div class="label">${esc(periodLabel)}</div></div>`
    + `<div class="stat wide"><div class="num">Participants</div><div class="label">`
    + (info.customerParticipants ? `<span class="ln">${esc(info.customer || 'Customer')} : ${esc(info.customerParticipants)}</span>` : '')
    + (info.doyensysParticipants ? `<span class="ln">Doyensys : ${esc(info.doyensysParticipants)}</span>` : '')
    + `</div></div>`
    + `<div class="stat"><div class="num">${esc(meetingDay)}</div><div class="label">Meeting Date, ${esc(meetingYear)}</div></div>`
    + `</div>`;

  html = html
    .replace(/<div class="meta-badge"><span>[\s\S]*?<\/span><\/div>/, `<div class="meta-badge"><span>${esc(info.teamName)}</span></div>`)
    .replace(/<span class="eyebrow on-dark">[\s\S]*?<\/span>/, `<span class="eyebrow on-dark">Weekly Cadence &middot; ${esc(cadence)}</span>`)
    .replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${esc(info.reportTitle)}<br><em>${esc(info.reportSubtitle)}</em></h1>`)
    .replace(/<div class="stat-strip wrap"[\s\S]*?<\/div>\n<\/header>/, `${statStrip}\n</header>`);

  // --------------------------------------------------------------- snapshot
  const reportWindow = from && to ? { start: utcDay(from), end: utcDay(to) } : null;

  // Which source owns the reported week. A section on the Tickets sheet wins:
  // it is the week's own export, and it says exactly which tickets are its own
  // rather than leaving them to be guessed at by date.
  const weekSection = reportWindow ? sectionFor(data.ticketSections, reportWindow) : undefined;
  if (weekSection && reportWindow && data.weeklyCounts.some((c) => sameWindow({ start: c.weekStart, end: c.weekEnd }, reportWindow))) {
    data.warnings.push(`The week of ${fmtLong(reportWindow.start)} appears both as a section on the Tickets sheet (row ${weekSection.rowNumber}) and as rows on the "Weekly Counts" sheet. The ticket section was used. Delete that week's Weekly Counts rows — that sheet is only for weeks with no ticket-level data.`);
  }

  // The tickets this week's tables are built from. With a section, exactly its
  // rows. Without one — an older file that is a single undivided block — fall
  // back to the whole sheet, which is what the report did before sections.
  const weekTickets = weekSection ? weekSection.tickets : tickets;

  const trackStats = TRACKS.map((tr) => {
    const row = weekSection || !reportWindow ? undefined : countRow(data.weeklyCounts, reportWindow, tr);
    const stats = statsFor(weekTickets.filter((t) => t.track === tr), from, to, row);
    // Carry-forward: the section banner when the week has a section, the
    // counts row otherwise. Never computed either way.
    const carry = weekSection ? (weekSection.carryForward[tr] ?? null) : stats.carry;
    if (reportWindow && carry === null && weekTickets.some((t) => t.track === tr)) {
      const where = weekSection
        ? `Fill "Carryforward ${tr}" on that week's banner row (row ${weekSection.rowNumber} of the Tickets sheet)`
        : 'Add a row for that week and track on the "Weekly Counts" sheet';
      data.warnings.push(`No Carryforward figure for ${tr} for the week of ${fmtLong(reportWindow.start)}. ${where} — carry-forward is never calculated, so the cell is left blank until it is typed.`);
    }
    return { track: tr, ...stats, carry };
  });
  // A total only means something when every track supplied one, so a missing
  // figure makes the total blank rather than silently under-counting.
  const carryTotal = trackStats.every((s) => s.carry !== null)
    ? trackStats.reduce((a, s) => a + (s.carry ?? 0), 0) : null;
  const tot = {
    open: sumOrNull(trackStats.map((s) => s.open)),
    received: sumOrNull(trackStats.map((s) => s.received)),
    resolved: sumOrNull(trackStats.map((s) => s.resolved)),
    carry: carryTotal,
  };

  // Classification: one row per report category. Received and Closed come from
  // the week's dates; the rest are a snapshot of where those tickets stand now.
  // The padding is tightened inline because the table carries eight columns in
  // a half-width card — at the shell's default cell padding the last column
  // falls off the edge, and a column that only appears when you scroll is a
  // column nobody reads.
  const CP = ' style="padding-left:6px;padding-right:6px"';
  const classRows = REPORT_CATEGORIES.map((cat) => {
    const rows = weekTickets.filter((t) => t.reportCategory === cat);
    const n = (v: number) => (v ? String(v) : '');
    const cell = (v: number) => `<td class="n"${CP}>${n(v)}</td>`;
    return `<tr><td${CP}>${esc(cat)}</td>`
      + cell(rows.filter((t) => inRange(t.openDate, from, to)).length)
      + cell(rows.filter((t) => inRange(t.closedDate, from, to)).length)
      + STATUS_ABBR.map((s) => cell(rows.filter((t) => t.status === s.status).length)).join('')
      + `</tr>`;
  }).filter((_, i) => weekTickets.some((t) => t.reportCategory === REPORT_CATEGORIES[i])).join('');
  const classHead = `<tr><th${CP}>Category</th><th class="n"${CP}>Received</th><th class="n"${CP}>Closed</th>`
    + STATUS_ABBR.map((s) => `<th class="n"${CP}>${esc(s.abbr)}</th>`).join('') + `</tr>`;
  const classNote = STATUS_ABBR.filter((s) => s.abbr !== s.full)
    .map((s) => `${s.abbr} - ${s.full}`).join(' &nbsp;&middot;&nbsp; ');
  const classCols = 3 + STATUS_ABBR.length;

  // ------------------------------------------------------- project hours
  // Weekly summary: only the Project Hours rows whose week is this report's
  // week (a weekly row belongs to the week its end date falls in). Monthly
  // history rows never appear here. Activities are listed as typed — the
  // hours have their own column, so they are not repeated in brackets.
  const weekHourRows = reportWindow
    ? data.projectHours.filter((h) => h.weekEnd
      && h.weekEnd.getTime() >= reportWindow.start.getTime() && h.weekEnd.getTime() <= reportWindow.end.getTime())
    : [];
  const weekHours = TRACKS.filter((tr) => weekHourRows.some((h) => h.track === tr)).map((tr) => {
    const rows = weekHourRows.filter((h) => h.track === tr);
    const acts = [...new Set(rows.map((h) => h.activity).filter((a) => a && a !== '—'))];
    return { track: tr, acts, hours: sumOrNull(rows.map((h) => h.hours)) };
  });
  const weekHoursTotal = sumOrNull(weekHours.map((w) => w.hours));
  const projectsCard = weekHours.length
    ? `<div class="snap-card reveal"><h4>Projects – Weekly Summary</h4><div class="snap-scroll"><table class="snap-table t-projects"><thead><tr><th>Track</th><th class="tx">Key Activities</th><th class="n"># Hours (for the week)</th></tr></thead><tbody>`
      + weekHours.map((w) => `<tr><td>${esc(w.track)}</td><td class="tx">${esc(w.acts.join(', '))}</td><td class="n">${show(w.hours)}</td></tr>`).join('')
      + `<tr class="total"><td>Total</td><td class="tx"></td><td class="n">${show(weekHoursTotal)}</td></tr></tbody></table></div></div>`
    : '';

  const snapshot = wrap(`    <span class="eyebrow">Weekly Snapshot</span>
    <h2 class="section-title">Snapshot – for the Week</h2>
    ${info.snapshotSummary ? `<p class="snap-summary">${esc(info.snapshotSummary)}</p>` : ''}
    <div class="snap-grid">
      <div class="snap-col">${panel('upd snap-hl', 'i-checklist', 'Key Highlights', 'Notable items for the week',
        bulletList(info.keyHighlights.map((h) => ({ text: h }))))}<div class="snap-card reveal"><h4>Tickets Classification</h4><div class="snap-scroll"><table class="snap-table t-classification"><thead>${classHead}</thead><tbody>${classRows || `<tr><td colspan="${classCols}">No tickets supplied.</td></tr>`}</tbody></table></div><p class="snap-note">*${classNote}</p></div></div>
      <div class="snap-col"><div class="snap-card reveal"><h4>Support – Weekly Tickets Summary</h4><div class="snap-scroll"><table class="snap-table t-support"><thead><tr><th>Track</th><th class="n">Open tickets</th><th class="n">#Tickets received</th><th class="n">#Tickets resolved</th><th class="n">Carry forward</th></tr></thead><tbody>${
        trackStats.map((s) => `<tr><td>${esc(s.track)}</td><td class="n">${show(s.open)}</td><td class="n">${show(s.received)}</td><td class="n">${show(s.resolved)}</td><td class="n">${show(s.carry)}</td></tr>`).join('')
      }<tr class="total"><td>Total</td><td class="n">${show(tot.open)}</td><td class="n">${show(tot.received)}</td><td class="n">${show(tot.resolved)}</td><td class="n">${show(tot.carry)}</td></tr></tbody></table></div></div>${projectsCard}</div>
    </div>`);
  html = replaceSectionBody(html, 'snapshot', snapshot);

  // ----------------------------------------------------------------- trends
  // Eight Wednesday-to-Tuesday windows, each one a set of dates somebody typed.
  const buckets = trendWindows(data, from, to);
  const labels = buckets.map((b) => b.label);
  const trackBlocks = TRACKS.map((tr) => {
    const tt = tickets.filter((t) => t.track === tr);
    const hasCounts = data.weeklyCounts.some((c) => c.track === tr);
    if (!tt.length && !hasCounts) return '';

    // Each bucket is filled by whichever source owns that week — the same rule
    // the summary table uses, applied week by week across the chart. That is
    // what lets one chart run the counts-only history straight into the weeks
    // that have a full ticket export.
    // Empty cells stay empty (null): they leave a gap in the line rather than
    // being drawn as zero.
    const recv: Val[] = [], clos: Val[] = [], carry: Val[] = [];
    for (const b of buckets) {
      const sec = sectionFor(data.ticketSections, b);
      const row = countRow(data.weeklyCounts, b, tr);
      if (sec) {
        const st = sec.tickets.filter((t) => t.track === tr);
        recv.push(st.filter((t) => inRange(t.openDate, b.start, b.end)).length);
        clos.push(st.filter((t) => inRange(t.closedDate, b.start, b.end)).length);
        carry.push(sec.carryForward[tr] ?? null);
      } else if (row) {
        // A typed counts row is used exactly as typed.
        recv.push(row.received);
        clos.push(row.closed);
        carry.push(row.carryForward);
      } else {
        recv.push(tt.filter((t) => inRange(t.openDate, b.start, b.end)).length);
        clos.push(tt.filter((t) => inRange(t.closedDate, b.start, b.end)).length);
        // Carry-forward is typed, never calculated — none typed, none shown.
        carry.push(null);
      }
    }

    return `<div class="trend-track"><div class="trend-track-hd">${esc(tr)} Track</div><div class="trend-grid">`
      + `<div class="trend-card reveal"><h4>${esc(tr)} Track – Received vs Closed</h4><div class="trend-legend"><span><i style="background:${RECEIVED}"></i>#Tickets received</span><span><i style="background:${RESOLVED}"></i>#Tickets resolved</span></div>`
      + trendLines(labels, [{ name: '#Tickets received', color: RECEIVED, values: recv }, { name: '#Tickets resolved', color: RESOLVED, values: clos }])
      + `</div><div class="trend-card reveal"><h4>${esc(tr)} Track – Carry Forward</h4><div class="trend-legend"><span><i style="background:${CARRY}"></i>Carry forward</span></div>`
      + trendLine(labels, carry, CARRY) + `</div></div></div>`;
  }).join('');

  // Project hours by month — the last three calendar months, ending with the
  // month this report's week ends in (or the latest month on the sheet when
  // no week was chosen). Monthly rows supply the history as typed; weekly
  // rows add up into their month as a running total, counting only weeks up
  // to the end of this report's week, so a mid-month report shows the month
  // so far. An empty Hours cell is not a zero: a month/track with no figure
  // stays blank in the table and draws no bar.
  const reportEnd = reportWindow ? reportWindow.end : null;
  const countedHours = data.projectHours.filter((h) => h.monthKey
    && (!h.weekEnd || !reportEnd || h.weekEnd.getTime() <= reportEnd.getTime()));
  const latestKey = countedHours.map((h) => h.monthKey!).sort().pop() ?? null;
  const anchor = reportEnd ? monthKeyOf(reportEnd) : latestKey;
  const months = anchor ? [shiftMonth(anchor, -2), shiftMonth(anchor, -1), anchor] : [];
  const cellHours = (tr: Track, mk: string) =>
    sumOrNull(countedHours.filter((h) => h.track === tr && h.monthKey === mk).map((h) => h.hours));
  const grid = months.map((mk) => TRACKS.map((tr) => cellHours(tr, mk)));
  const anyHours = grid.some((row) => row.some((v) => v !== null));
  const MONTH_SHADES = ['rgb(184,203,232)', 'rgb(108,131,167)', 'rgb(31,58,102)'];

  const hoursBlock = anyHours
    ? `<div class="trend-track"><div class="trend-track-hd">Project Hours</div><div class="trend-grid ph-grid">`
      + `<div class="trend-card reveal"><h4>Project Hours – by Month</h4><p class="ph-note">Hours logged per track</p><div class="snap-scroll"><table class="snap-table ph-table"><thead><tr><th>Month</th>`
      + TRACKS.map((tr) => `<th class="n">${esc(tr)}</th>`).join('') + `<th class="n">Total</th></tr></thead><tbody>`
      + months.map((mk, mi) => {
        const rowTotal = sumOrNull(grid[mi]);
        return `<tr><td>${esc(monthLabel(mk))}</td>` + grid[mi].map((v) => `<td class="n">${show(v)}</td>`).join('')
          + `<td class="n"><b>${show(rowTotal)}</b></td></tr>`;
      }).join('')
      + `<tr class="total"><td>Total</td>` + TRACKS.map((_, ti) => `<td class="n">${show(sumOrNull(grid.map((row) => row[ti])))}</td>`).join('')
      + `<td class="n">${show(sumOrNull(grid.flat()))}</td></tr></tbody></table></div></div>`
      + `<div class="trend-card reveal"><h4>Project Hours – by Track</h4><div class="trend-legend">`
      + months.map((mk, mi) => `<span><i style="background:${MONTH_SHADES[mi]};height:10px;width:10px;border-radius:3px"></i>${esc(monthLabel(mk))}</span>`).join('')
      + `</div>`
      + hoursBars([...TRACKS], months.map((mk, mi) => ({ name: monthLabel(mk), color: MONTH_SHADES[mi], values: grid[mi] })))
      + `</div></div></div>` : '';

  if (!trackBlocks && !hoursBlock) {
    html = removeSection(html, 'trends');
    html = removeNavLink(html, 'trends');
  } else {
    html = replaceSectionBody(html, 'trends', wrap(`    <span class="eyebrow">Ticket Trends</span>
    <h2 class="section-title">Ticket Trends by Track</h2>
    <p class="section-sub">Week-on-week tickets received vs closed, and the carry-forward backlog, for each support track.</p>
${trackBlocks}${hoursBlock}`));
  }

  // ----------------------------------------------- workstream activity sections
  const WORKSTREAM_SECTIONS: { id: string; ws: string; eyebrow: string; order: string[]; cols: string }[] = [
    { id: 'status', ws: 'DBA & Infra', eyebrow: 'DBA &amp; Infra Track', order: ['Updates', 'Recommendations'], cols: '' },
    { id: 'scp', ws: 'Fusion SCP', eyebrow: 'Applications Track: Fusion SCP', order: ['Closed', 'WIP', 'On-Hold', 'Others'], cols: ' scp-cols' },
    { id: 'ebs', ws: 'Oracle EBS', eyebrow: 'Applications Track: Oracle EBS', order: ['Closed', 'WIP', 'On-Hold', 'Others'], cols: ' scp-cols' },
  ];
  for (const s of WORKSTREAM_SECTIONS) {
    const rows = data.activities.filter((a) => a.workstream === s.ws);
    const panels = activityPanels(rows, s.order);
    if (!panels) {
      html = removeSection(html, s.id);
      html = removeNavLink(html, s.id);
      continue;
    }
    const sub = s.id === 'status' && info.dbaInfraSummary ? `\n    <p class="section-sub">${esc(info.dbaInfraSummary)}</p>` : '';
    html = replaceSectionBody(html, s.id, wrap(`    <span class="eyebrow">${s.eyebrow}</span>
    <h2 class="section-title">Activities Update</h2>${sub}
    <div class="update-cols${s.cols}">${panels}</div>`));
  }

  // ----------------------------------------------------- value / proj / act / help
  const sectionsWithRows: { id: string; eyebrow: string; title: string; panelTitle: string; panelSub: string; rows: SimpleRow[]; headless?: boolean }[] = [
    { id: 'val', eyebrow: 'Applications, Infra &amp; DBA Tracks', title: 'Value Additions / Initiatives', panelTitle: 'Key Updates', panelSub: 'Value delivered & initiatives this week', rows: data.valueAdditions },
    { id: 'proj', eyebrow: 'Applications Track', title: 'Projects - Activities Update', panelTitle: '', panelSub: '', rows: data.projectUpdates, headless: true },
    { id: 'act', eyebrow: 'Applications, Infra &amp; DBA Tracks', title: 'Action Items', panelTitle: 'Status Update', panelSub: 'Progress on open action items', rows: data.actionItems },
    { id: 'help', eyebrow: 'Applications, Infra &amp; DBA Tracks', title: 'Help Needed / Other Updates', panelTitle: '', panelSub: '', rows: data.helpNeeded, headless: true },
  ];
  for (const s of sectionsWithRows) {
    if (!s.rows.length) {
      html = removeSection(html, s.id);
      html = removeNavLink(html, s.id);
      continue;
    }
    html = replaceSectionBody(html, s.id, wrap(`    <span class="eyebrow">${s.eyebrow}</span>
    <h2 class="section-title">${esc(s.title)}</h2>
    <div class="val-wrap">${simplePanel(s.panelTitle, s.panelSub, s.rows, { headless: s.headless })}</div>`));
  }

  // ---------------------------------------------------------------- contacts
  if (data.contacts.length) {
    const btns = data.contacts.map((c) =>
      `<a href="mailto:${esc(c.email)}" class="btn btn-white"><svg class="btn-ico" aria-hidden="true"><use href="#i-mail"/></svg>${esc(c.name)}</a>`).join('');
    html = html.replace(/(<section class="cta-band" id="contact">[\s\S]*?)(<a href="mailto:[\s\S]*?)(<\/div>\s*<\/div>\s*<\/section>)/,
      (_m, head: string, _old: string, tail: string) => head + btns + tail);
  }

  return html;
}
