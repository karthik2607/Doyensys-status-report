import { WEEKLY_REPORT_SHELL } from '../assets/weeklyReportShell';
import {
  WeeklyReportData, ReportTicket, Track, TRACKS, WORKSTREAMS, REPORT_CATEGORIES,
  ActivityRow, SimpleRow, WeeklyCountRow, TicketSection, STATUS_ABBR,
  countOpenTickets, openFromCounts,
  startOfReportWeek, endOfReportWeek, addDays, utcDay, sameWindow,
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

function trendBars(labels: string[], series: { name: string; color: string; values: number[] }[]): string {
  const W = 560, H = 260, padL = 40, padR = 18, padT = 26, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = Math.max(1, labels.length);
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const step = Math.max(1, Math.ceil(max / 3));
  const niceMax = step * 3;
  const bandW = plotW / n;
  const barW = Math.max(4, Math.min(18, (bandW - 10) / series.length - 3));
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const grid = [0, 1, 2, 3].map((k) => {
    const v = step * k;
    const gy = y(v);
    return `<line x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${k === 0 ? '#C9CCD2' : '#ECEDEF'}" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${gy.toFixed(1)}" dy="3.5" text-anchor="end" font-size="11" fill="#9AA0AC">${v}</text>`;
  }).join('');

  const cols = labels.map((lab, i) => {
    const cx = padL + bandW * i + bandW / 2;
    const bars = series.map((s, si) => {
      const v = s.values[i] || 0;
      const h = padT + plotH - y(v);
      const x = cx - (series.length * (barW + 3)) / 2 + si * (barW + 3);
      const lbl = v > 0
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#1B1F27" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">${v}</text>` : '';
      return `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" fill="${s.color}" rx="3"/>${lbl}`;
    }).join('');
    return bars + `<text x="${cx.toFixed(1)}" y="${H - 20}" text-anchor="middle" font-size="11" fill="#6B7078">${esc(lab)}</text>`;
  }).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" font-family="Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif">${grid}${cols}</svg>`;
}

function trendLine(labels: string[], values: number[], color: string): string {
  const W = 560, H = 260, padL = 40, padR = 18, padT = 26, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = labels.length;
  if (!n) return '';
  const max = Math.max(1, ...values);
  const step = Math.max(1, Math.ceil(max / 3));
  const niceMax = step * 3;
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const grid = [0, 1, 2, 3].map((k) => {
    const v = step * k, gy = y(v);
    return `<line x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${k === 0 ? '#C9CCD2' : '#ECEDEF'}" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${gy.toFixed(1)}" dy="3.5" text-anchor="end" font-size="11" fill="#9AA0AC">${v}</text>`;
  }).join('');

  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  const gid = 'cf' + color.replace('#', '');
  const dots = values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/>`).join('');
  const vals = values.map((v, i) => `<text x="${x(i).toFixed(1)}" y="${(y(v) - 10).toFixed(1)}" text-anchor="middle" font-size="11.5" font-weight="700" fill="#1B1F27" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">${v}</text>`).join('');
  const labs = labels.map((lab, i) => {
    const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
    return `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="${anchor}" font-size="11" fill="#6B7078">${esc(lab)}</text>`;
  }).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" font-family="Segoe UI, -apple-system, Helvetica Neue, Arial, sans-serif">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#${gid})"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}${vals}${labs}</svg>`;
}

function donutSvg(items: { name: string; value: number; color: string }[]): string {
  const present = items.filter((i) => i.value > 0);
  const total = present.reduce((s, i) => s + i.value, 0);
  if (!total) return '';
  const size = 220, r = 100, inner = 62, cx = 110, cy = 110;

  // One category is a complete ring; an arc whose start equals its end draws
  // nothing, so that case has to be a stroked circle instead.
  if (present.length === 1) {
    const o = present[0];
    return `<svg class="trend-svg" viewBox="0 0 ${size} ${size}" role="img"><circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${o.color}" stroke-width="${r - inner}"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="30" font-weight="800" fill="#1B1F27">${total}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="11" fill="#9AA0AC">HOURS</text></svg>`;
  }

  let a = -Math.PI / 2;
  const arcs = present.map((it) => {
    const sweep = (it.value / total) * Math.PI * 2;
    const gap = Math.min(0.03, sweep * 0.06);
    const a0 = a + gap / 2, a1 = a + sweep - gap / 2;
    a += sweep;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    return `<path d="M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z" fill="${it.color}"><title>${esc(it.name)}: ${it.value}</title></path>`;
  }).join('');

  return `<svg class="trend-svg" viewBox="0 0 ${size} ${size}" role="img">${arcs}
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="30" font-weight="800" fill="#1B1F27">${total}</text>
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="11" fill="#9AA0AC">HOURS</text></svg>`;
}

// ---------------------------------------------------------------------------
// Panels (the update-panel pattern from the source report)
// ---------------------------------------------------------------------------

/** Renders a list where a row whose `parent` matches an earlier row's title
 * becomes a nested <ul class="sub-list"> under it — the indented bullets in
 * the source report. */
function bulletList(rows: { text: string; parent?: string }[]): string {
  const tops = rows.filter((r) => !r.parent);
  if (!tops.length && rows.length) {
    return `<ul class="update-list">${rows.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>`;
  }
  return `<ul class="update-list">${tops.map((t) => {
    const kids = rows.filter((r) => r.parent && r.parent.trim().toLowerCase() === t.text.trim().toLowerCase());
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

interface TrackStats { open: number; received: number; resolved: number; carry: number | null; }

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
  const received = row?.received ?? tickets.filter((t) => inRange(t.openDate, from, to)).length;
  const resolved = row?.closed ?? tickets.filter((t) => inRange(t.closedDate, from, to)).length;
  // Open tickets = WIP + Open + AUC + AUR + AM + Hold: a headcount by current
  // status (see countOpenTickets). A counts-only week has no ticket rows to
  // count, so the same six figures typed on its Weekly Counts row are added up
  // instead. Carry-forward, below, is NOT derived from this — it is typed.
  const open = (row ? openFromCounts(row) : null) ?? countOpenTickets(tickets);
  return { open, received, resolved, carry: row?.carryForward ?? null };
}

export interface TrendWindow { label: string; start: Date; end: Date; }

/**
 * The windows the trend charts run over: the six most recent, newest last.
 *
 * Every window comes from dates somebody typed — a section banner on the
 * Tickets sheet, a Week Start / Week End pair on the Weekly Counts sheet, or
 * the week the report itself is being generated for. Nothing is invented by
 * stepping back seven days at a time, so a week shortened by a holiday charts
 * exactly as it was entered, and a week nobody entered simply isn't on the
 * chart rather than appearing as a false zero.
 */
function trendWindows(data: WeeklyReportData, from: Date | null, to: Date | null, weeks = 6): TrendWindow[] {
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
    open: trackStats.reduce((a, s) => a + s.open, 0),
    received: trackStats.reduce((a, s) => a + s.received, 0),
    resolved: trackStats.reduce((a, s) => a + s.resolved, 0),
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

  const hoursByTrack = new Map<Track, { acts: string[]; hours: number }>();
  for (const h of data.projectHours) {
    const e = hoursByTrack.get(h.track) ?? { acts: [], hours: 0 };
    if (h.activity && h.activity !== '—') e.acts.push(`${h.activity} (${h.hours})`);
    e.hours += h.hours;
    hoursByTrack.set(h.track, e);
  }
  const totalHours = data.projectHours.reduce((s, r) => s + r.hours, 0);

  const snapshot = wrap(`    <span class="eyebrow">Weekly Snapshot</span>
    <h2 class="section-title">Snapshot – for the Week</h2>
    ${info.snapshotSummary ? `<p class="snap-summary">${esc(info.snapshotSummary)}</p>` : ''}
    <div class="snap-grid">
      <div class="snap-col">${panel('upd snap-hl', 'i-checklist', 'Key Highlights', 'Notable items for the week',
        bulletList(info.keyHighlights.map((h) => ({ text: h }))))}<div class="snap-card reveal"><h4>Tickets Classification</h4><div class="snap-scroll"><table class="snap-table t-classification"><thead>${classHead}</thead><tbody>${classRows || `<tr><td colspan="${classCols}">No tickets supplied.</td></tr>`}</tbody></table></div><p class="snap-note">*${classNote}</p></div></div>
      <div class="snap-col"><div class="snap-card reveal"><h4>Support – Weekly Tickets Summary</h4><div class="snap-scroll"><table class="snap-table t-support"><thead><tr><th>Track</th><th class="n">Open tickets</th><th class="n">#Tickets received</th><th class="n">#Tickets resolved</th><th class="n">Carry forward</th></tr></thead><tbody>${
        trackStats.map((s) => `<tr><td>${esc(s.track)}</td><td class="n">${s.open}</td><td class="n">${s.received}</td><td class="n">${s.resolved}</td><td class="n">${s.carry ?? '—'}</td></tr>`).join('')
      }<tr class="total"><td>Total</td><td class="n">${tot.open}</td><td class="n">${tot.received}</td><td class="n">${tot.resolved}</td><td class="n">${tot.carry ?? '—'}</td></tr></tbody></table></div></div><div class="snap-card reveal"><h4>Projects – Weekly Summary</h4><div class="snap-scroll"><table class="snap-table t-projects"><thead><tr><th>Track</th><th class="tx">Key Activities</th><th class="n"># Hours (for the week)</th></tr></thead><tbody>${
        // Only tracks that actually have a Project Hours row. A track with no
        // row at all has nothing to report, and an empty line in a customer
        // document reads as missing data rather than as "none this week".
        TRACKS.filter((tr) => hoursByTrack.has(tr)).map((tr) => { const e = hoursByTrack.get(tr)!; return `<tr><td>${esc(tr)}</td><td class="tx">${esc(e.acts.join(', '))}</td><td class="n">${e.hours}</td></tr>`; }).join('')
      }<tr class="total"><td>Total</td><td class="tx"></td><td class="n">${totalHours}</td></tr></tbody></table></div></div></div>
    </div>`);
  html = replaceSectionBody(html, 'snapshot', snapshot);

  // ----------------------------------------------------------------- trends
  // Six Wednesday-to-Tuesday windows, each one a set of dates somebody typed.
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
    const recv: number[] = [], clos: number[] = [], carry: number[] = [];
    for (const b of buckets) {
      const sec = sectionFor(data.ticketSections, b);
      const row = countRow(data.weeklyCounts, b, tr);
      if (sec) {
        const st = sec.tickets.filter((t) => t.track === tr);
        recv.push(st.filter((t) => inRange(t.openDate, b.start, b.end)).length);
        clos.push(st.filter((t) => inRange(t.closedDate, b.start, b.end)).length);
        carry.push(sec.carryForward[tr] ?? 0);
      } else {
        recv.push(row?.received ?? tt.filter((t) => inRange(t.openDate, b.start, b.end)).length);
        clos.push(row?.closed ?? tt.filter((t) => inRange(t.closedDate, b.start, b.end)).length);
        // Carry-forward is typed for every week without exception.
        carry.push(row?.carryForward ?? 0);
      }
    }

    return `<div class="trend-track"><div class="trend-track-hd">${esc(tr)} Track</div><div class="trend-grid">`
      + `<div class="trend-card reveal"><h4>${esc(tr)} Track – Received vs Closed</h4><div class="trend-legend"><span><i style="background:${RECEIVED}"></i>#Tickets received</span><span><i style="background:${RESOLVED}"></i>#Tickets resolved</span></div>`
      + trendBars(labels, [{ name: 'received', color: RECEIVED, values: recv }, { name: 'resolved', color: RESOLVED, values: clos }])
      + `</div><div class="trend-card reveal"><h4>${esc(tr)} Track – Carry Forward</h4><div class="trend-legend"><span><i style="background:${CARRY}"></i>Carry forward</span></div>`
      + trendLine(labels, carry, CARRY) + `</div></div></div>`;
  }).join('');

  const monthMap = new Map<string, number>();
  for (const h of data.projectHours) monthMap.set(h.month, (monthMap.get(h.month) ?? 0) + h.hours);
  const months = [...monthMap.keys()];
  // Rows with zero hours are legitimate (an activity tracked but not worked
  // this week), but charting them leaves an empty donut and a flat bar axis,
  // so the whole block only appears once there are hours to show.
  const hoursBlock = totalHours > 0
    ? `<div class="trend-track"><div class="trend-track-hd">Project Hours</div><div class="trend-grid">`
      + `<div class="trend-card reveal"><h4>Project Hours – by Month</h4>`
      + trendBars(months, [{ name: 'Hours', color: RECEIVED, values: months.map((m) => monthMap.get(m) ?? 0) }])
      + `</div><div class="trend-card reveal"><h4>Project Hours – by Track</h4><div class="trend-legend">`
      + TRACKS.filter((t) => (hoursByTrack.get(t)?.hours ?? 0) > 0).map((t, i) => `<span><i style="background:${[RECEIVED, RESOLVED, CARRY][i % 3]}"></i>${esc(t)}</span>`).join('')
      + `</div>` + donutSvg(TRACKS.filter((t) => (hoursByTrack.get(t)?.hours ?? 0) > 0).map((t, i) => ({ name: t, value: hoursByTrack.get(t)!.hours, color: [RECEIVED, RESOLVED, CARRY][i % 3] })))
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
