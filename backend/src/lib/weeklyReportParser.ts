import ExcelJS from 'exceljs';
import {
  WeeklyReportData, ReportTicket, ProjectHoursRow, ActivityRow, SimpleRow, ReportInfo,
  normalizePriority, normalizeStatus, normalizeTrack, guessTrackFromModule, Track,
  normalizeReportCategory, ContactRow, Workstream, WORKSTREAMS,
  WeeklyCountRow, TicketSection, ReportWindow, WEEK_START_DAY, utcDay, fmtISO,
} from './weeklyReportModel';

// ===========================================================================
// WEEKLY STATUS REPORT — reading a filled-in template
//
// Written to be forgiving about everything except the things that would make
// the output wrong:
//   • Header names are matched case- and space-insensitively, and several
//     aliases are accepted, so a sheet exported from the old tracker still
//     lines up.
//   • Sheets may be missing entirely — the matching section just drops out.
//   • Messy values are normalised rather than rejected (see weeklyReportModel).
// What it will not do is silently invent data: anything it had to guess at
// comes back in `warnings` and is shown to the user before they download.
// ===========================================================================

/** The template ships with sample rows so a first-time user can see the
 * expected shape and generate something immediately. They are prefixed with
 * this marker and skipped on import, so forgetting to delete them can never
 * put invented data into a report that goes to a customer. */
const EXAMPLE_MARKER = /^\s*example\s*[-–—:]/i;
function isExample(...values: string[]): boolean {
  return values.some((v) => EXAMPLE_MARKER.test(v || ''));
}

function norm(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}
function normKey(v: unknown): string {
  return norm(v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** ExcelJS hands back rich text, hyperlink objects, formula results and
 * plain values depending on how the cell was authored. Flatten them all. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.result === 'string' || typeof o.result === 'number') return String(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((p) => p.text).join('');
    if (o.hyperlink && typeof o.text === 'string') return String(o.text);
    return '';
  }
  return String(v);
}

function cellDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'object') {
    const r = (v as { result?: unknown }).result;
    if (r instanceof Date) return r;
  }
  const s = cellText(v).trim();
  if (!s) return null;
  // Excel serial dates occasionally survive as plain numbers.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function cellNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  const s = cellText(v).replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

/** Finds the header row in a sheet and returns a column-name -> index map.
 * The template puts a title and a help line above the headers, and a file
 * from somewhere else may have its own preamble, so the header row is
 * located by content rather than assumed to be row 1. */
function findHeaders(ws: ExcelJS.Worksheet, required: string[]): { rowNumber: number; map: Record<string, number> } | null {
  const wanted = required.map(normKey);
  const limit = Math.min(ws.rowCount, 25);
  for (let r = 1; r <= limit; r++) {
    const row = ws.getRow(r);
    const map: Record<string, number> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const k = normKey(cellText(cell.value));
      // First occurrence wins, deliberately: the TrackIT export carries two
      // columns called "Status" — the real ticket status at F and a constant
      // "OPEN" at S. Taking the leftmost picks the meaningful one.
      if (k && !(k in map)) map[k] = col;
    });
    const hits = wanted.filter((w) => w in map).length;
    // Two matches is enough to identify the row without tripping over a
    // title line that happens to contain one of the words.
    if (hits >= Math.min(2, wanted.length)) return { rowNumber: r, map };
  }
  return null;
}

function pick(map: Record<string, number>, aliases: string[]): number | undefined {
  for (const a of aliases) {
    const k = normKey(a);
    if (k in map) return map[k];
  }
  return undefined;
}

function sheet(wb: ExcelJS.Workbook, ...names: string[]): ExcelJS.Worksheet | null {
  for (const n of names) {
    const found = wb.worksheets.find((w) => normKey(w.name) === normKey(n));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------

function parseInfo(wb: ExcelJS.Workbook, warnings: string[]): ReportInfo {
  const ws = sheet(wb, 'Report Info', 'ReportInfo', 'Info');
  const out: ReportInfo = {
    customer: '', reportTitle: 'Weekly Status Update',
    reportSubtitle: 'Managed Services', teamName: 'Team: Applications & Infra Support',
    snapshotSummary: '', dbaInfraSummary: '',
    periodStart: null, periodEnd: null, meetingDate: null, preparedBy: '',
    customerParticipants: '', doyensysParticipants: '',
    scope: 'Support (Applications, Infra, DBA), Projects', keyHighlights: [],
  };
  if (!ws) {
    warnings.push('No "Report Info" sheet found — the report header and reporting period will be blank.');
    return out;
  }
  // Field/Value pairs, read by label rather than by position so inserting a
  // row in the template doesn't shift everything.
  const byLabel = new Map<string, ExcelJS.CellValue>();
  ws.eachRow((row) => {
    const label = normKey(cellText(row.getCell(1).value));
    if (label) byLabel.set(label, row.getCell(2).value);
  });
  const get = (...labels: string[]) => {
    for (const l of labels) {
      const v = byLabel.get(normKey(l));
      if (v !== undefined && cellText(v).trim() !== '') return v;
    }
    return undefined;
  };

  out.customer = norm(cellText(get('Customer')));
  out.reportTitle = norm(cellText(get('Report Title'))) || out.reportTitle;
  out.reportSubtitle = norm(cellText(get('Report Subtitle'))) || out.reportSubtitle;
  out.teamName = norm(cellText(get('Team Name'))) || out.teamName;
  out.snapshotSummary = norm(cellText(get('Snapshot Summary')));
  out.dbaInfraSummary = norm(cellText(get('DBA & Infra Summary')));
  out.periodStart = cellDate(get('Reporting Period Start', 'Period Start'));
  out.periodEnd = cellDate(get('Reporting Period End', 'Period End'));
  out.meetingDate = cellDate(get('Meeting Date'));
  out.preparedBy = norm(cellText(get('Prepared By')));
  out.customerParticipants = norm(cellText(get('Customer Participants')));
  out.doyensysParticipants = norm(cellText(get('Doyensys Participants')));
  out.scope = norm(cellText(get('Scope'))) || out.scope;
  for (let i = 1; i <= 10; i++) {
    const h = norm(cellText(get(`Key Highlight ${i}`)));
    if (h) out.keyHighlights.push(h);
  }
  if (!out.periodStart || !out.periodEnd) {
    warnings.push('Reporting period start/end is missing — weekly received, resolved and carry-forward counts cannot be calculated, so those columns will read 0.');
  }
  return out;
}

/** Columns the ticket rows are read from, resolved against one header row.
 * Each section repeats its headers, so this is resolved per section rather
 * than once for the sheet — a section pasted with shifted columns still reads
 * correctly instead of quietly mapping to the wrong fields. */
function ticketColumns(m: Record<string, number>) {
  return {
    id: pick(m, ['Ticket Id', 'TicketId', 'Ticket #', 'Id']),
    summary: pick(m, ['Ticket Summary', 'Summary', 'Description', 'Title']),
    track: pick(m, ['Track']),
    reportCategory: pick(m, ['Report Category']),
    priority: pick(m, ['Priority']),
    type: pick(m, ['Type']),
    module: pick(m, ['Module']),
    status: pick(m, ['Status']),
    assignedTo: pick(m, ['Assigned To', 'Assignee', 'Assigned To Technician']),
    requestor: pick(m, ['Requestor', 'Requester', 'Raised By']),
    openDate: pick(m, ['Open Date', 'Created Date', 'Raised Date']),
    closedDate: pick(m, ['Closed Date', 'Close Date', 'Resolved Date']),
    sla: pick(m, ['SLA Days', 'no of days delay (SLA)', 'SLA']),
  };
}
type TicketColumns = ReturnType<typeof ticketColumns>;

/** Reads one ticket row. Returns null for a row that is padding rather than a
 * ticket, and reports whether the Track had to be guessed. */
function readTicketRow(row: ExcelJS.Row, col: TicketColumns): { ticket: ReportTicket; guessed: boolean } | null {
  const val = (c?: number) => (c ? row.getCell(c).value : undefined);
  const id = norm(cellText(val(col.id)));
  const summary = norm(cellText(val(col.summary)));
  if (!id && !summary) return null;
  if (isExample(summary)) return null;

  const moduleName = norm(cellText(val(col.module)));
  let track = normalizeTrack(cellText(val(col.track)));
  let guessed = false;
  if (!track) {
    track = guessTrackFromModule(moduleName);
    guessed = true;
  }

  return {
    guessed,
    ticket: {
      ticketId: id || '—',
      reportCategory: normalizeReportCategory(cellText(val(col.reportCategory)), cellText(val(col.type)), moduleName),
      summary: summary || '(no summary)',
      track: track as Track,
      priority: normalizePriority(cellText(val(col.priority))),
      type: norm(cellText(val(col.type))) || 'Other',
      module: moduleName || '—',
      status: normalizeStatus(cellText(val(col.status))),
      assignedTo: norm(cellText(val(col.assignedTo))) || '—',
      requestor: norm(cellText(val(col.requestor))) || '—',
      openDate: cellDate(val(col.openDate)),
      closedDate: cellDate(val(col.closedDate)),
      slaDays: cellNumber(val(col.sla)),
    },
  };
}

/** Builds the header-name -> column map for one row. */
function headerMapAt(row: ExcelJS.Row): Record<string, number> {
  const map: Record<string, number> = {};
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const k = normKey(cellText(cell.value));
    // First occurrence wins — the TrackIT export has two "Status" columns and
    // the leftmost is the meaningful one.
    if (k && !(k in map)) map[k] = col;
  });
  return map;
}

const SECTION_START_LABEL = normKey('Start Date');
const SECTION_END_LABEL = normKey('End Date');

/** A banner row is recognised by its "Start Date" label, not by position. */
function bannerFields(row: ExcelJS.Row): { start: Date | null; end: Date | null; carry: Partial<Record<Track, number>> } | null {
  const labels: { key: string; col: number }[] = [];
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const k = normKey(cellText(cell.value));
    if (k) labels.push({ key: k, col });
  });
  if (!labels.some((l) => l.key === SECTION_START_LABEL)) return null;

  // Every value sits in the cell immediately right of its label.
  const valueAt = (col: number) => row.getCell(col + 1).value;
  let start: Date | null = null, end: Date | null = null;
  const carry: Partial<Record<Track, number>> = {};
  for (const { key, col } of labels) {
    if (key === SECTION_START_LABEL) start = cellDate(valueAt(col));
    else if (key === SECTION_END_LABEL) end = cellDate(valueAt(col));
    else if (key.startsWith(normKey('Carryforward'))) {
      const track = normalizeTrack(key.replace(/carry\s*-?\s*forward/i, ''));
      const n = cellNumber(valueAt(col));
      if (track && n !== null) carry[track] = n;
    }
  }
  return { start, end, carry };
}

/**
 * Reads the Tickets sheet.
 *
 * The sheet is laid out as one section per reporting week: a banner row
 * carrying that week's dates and per-track carry-forward, the column headers,
 * then the week's tickets. The sheet is walked top to bottom and every row is
 * classified as banner, header, or ticket.
 *
 * A sheet with no banner at all — every file filled in before sections
 * existed — still parses: it becomes a single section with no dates, which the
 * renderer treats exactly as it used to.
 */
function parseTickets(wb: ExcelJS.Workbook, warnings: string[]): { tickets: ReportTicket[]; sections: TicketSection[] } {
  const ws = sheet(wb, 'Tickets', 'Ticket', 'Open Ticket');
  if (!ws) {
    warnings.push('No "Tickets" sheet found — the report will have no ticket numbers or charts.');
    return { tickets: [], sections: [] };
  }

  const sections: TicketSection[] = [];
  const all: ReportTicket[] = [];
  let guessedTracks = 0;
  let current: TicketSection | null = null;
  let col: TicketColumns | null = null;

  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    const banner = bannerFields(row);
    if (banner) {
      current = { start: banner.start, end: banner.end, carryForward: banner.carry, tickets: [], rowNumber: r };
      sections.push(current);
      col = null;                       // headers for this section come next
      continue;
    }

    const map = headerMapAt(row);
    const looksLikeHeader = normKey('Ticket Id') in map && (normKey('Status') in map || normKey('Open Date') in map);
    if (looksLikeHeader) {
      col = ticketColumns(map);
      // A sheet that starts with headers and no banner is the old single-block
      // layout. Give it one anonymous section so everything downstream has a
      // section to work with.
      if (!current) {
        current = { start: null, end: null, carryForward: {}, tickets: [], rowNumber: r };
        sections.push(current);
      }
      continue;
    }

    if (!col || !current) continue;     // title, help or stray row above the first headers
    const read = readTicketRow(row, col);
    if (!read) continue;
    if (read.guessed) guessedTracks++;
    current.tickets.push(read.ticket);
    all.push(read.ticket);
  }

  if (!sections.length) {
    warnings.push('Could not find a header row on the Tickets sheet — expected columns like "Ticket Id" and "Status".');
    return { tickets: [], sections: [] };
  }
  if (guessedTracks > 0) {
    warnings.push(`${guessedTracks} ticket${guessedTracks === 1 ? ' had its' : 's had their'} Track guessed from the Module name because the Track column was blank. Check those rows if the track split looks wrong.`);
  }
  for (const s of sections) {
    if (s.rowNumber && s.start && !s.end) {
      warnings.push(`The week section starting at row ${s.rowNumber} on the Tickets sheet has a Start Date but no End Date, so it cannot be matched to a reporting week.`);
    }
  }
  if (all.length === 0) warnings.push('The Tickets sheet has a header row but no ticket rows under it.');
  return { tickets: all, sections: sections.filter((s) => s.tickets.length || (s.start && s.end)) };
}

function parseProjectHours(wb: ExcelJS.Workbook): ProjectHoursRow[] {
  const ws = sheet(wb, 'Project Hours', 'ProjectHours', 'Hours');
  if (!ws) return [];
  const hdr = findHeaders(ws, ['Track', 'Hours']);
  if (!hdr) return [];
  const m = hdr.map;
  const cTrack = pick(m, ['Track']), cAct = pick(m, ['Activity', 'Key Activities']), cHrs = pick(m, ['Hours', '# Hours']), cMon = pick(m, ['Month', 'Period']);
  const out: ProjectHoursRow[] = [];
  for (let r = hdr.rowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const track = normalizeTrack(cellText(cTrack ? row.getCell(cTrack).value : ''));
    const hours = cellNumber(cHrs ? row.getCell(cHrs).value : null);
    const activity = norm(cellText(cAct ? row.getCell(cAct).value : ''));
    if (!track || (hours === null && !activity)) continue;
    if (isExample(activity)) continue;
    out.push({ track, activity: activity || '—', hours: hours ?? 0, month: norm(cellText(cMon ? row.getCell(cMon).value : '')) || '—' });
  }
  return out;
}

/** Reads the Weekly Counts sheet.
 *
 * The dates on each row ARE the window — they are taken at face value and
 * never snapped to a calendar grid, so a short week over a holiday needs no
 * special handling. A row whose dates don't describe a Wednesday-to-Tuesday
 * span is still kept (the figures are real), but it is called out in the
 * warnings so a typo in a date doesn't quietly become its own trend bucket. */
function parseWeeklyCounts(wb: ExcelJS.Workbook, warnings: string[]): WeeklyCountRow[] {
  const ws = sheet(wb, 'Weekly Counts', 'WeeklyCounts', 'Counts', 'Weekly Summary');
  if (!ws) return [];
  const hdr = findHeaders(ws, ['Week Start', 'Track']);
  if (!hdr) {
    warnings.push('The "Weekly Counts" sheet is there but its header row could not be found, so no historic weeks were read. The header row must contain at least "Week Start" and "Track".');
    return [];
  }
  const m = hdr.map;
  const c = {
    start: pick(m, ['Week Start', 'Start', 'Period Start', 'From']),
    end: pick(m, ['Week End', 'End', 'Period End', 'To']),
    track: pick(m, ['Track', 'Process']),
    received: pick(m, ['Received', '#Tickets received', 'Tickets Received']),
    closed: pick(m, ['Closed', 'Resolved', '#Tickets resolved']),
    onHold: pick(m, ['On Hold', 'Hold', 'OnHold']),
    wip: pick(m, ['WIP', 'Work in Progress']),
    auc: pick(m, ['AUC', 'Awaiting User Confirmation']),
    aur: pick(m, ['AUR', 'Awaiting User Response']),
    am: pick(m, ['AM', 'Awaiting Migration']),
    open: pick(m, ['Open', 'Open Tickets']),
    carry: pick(m, ['Carryforward', 'Carry Forward', 'Carry-forward', 'CarryForward']),
  };
  if (c.carry === undefined) {
    warnings.push('The "Weekly Counts" sheet has no "Carryforward" column, so carry-forward is blank throughout the report. Add that column and fill it in.');
  }

  const num = (r: ExcelJS.Row, col?: number) => (col === undefined ? null : cellNumber(r.getCell(col).value));
  const out: WeeklyCountRow[] = [];
  for (let r = hdr.rowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawTrack = cellText(c.track ? row.getCell(c.track).value : '');
    if (isExample(rawTrack)) continue;
    const track = normalizeTrack(rawTrack);
    const weekStart = c.start ? cellDate(row.getCell(c.start).value) : null;
    const weekEnd = c.end ? cellDate(row.getCell(c.end).value) : null;
    if (!track && !weekStart) continue;   // genuinely blank row

    if (!track) {
      warnings.push(`Weekly Counts row ${r} has no recognisable Track (Applications, Infra or DBA) and was skipped.`);
      continue;
    }
    if (!weekStart || !weekEnd) {
      warnings.push(`Weekly Counts row ${r} (${track}) is missing a Week Start or Week End date and was skipped — those two dates are what place the row on the trend charts.`);
      continue;
    }
    const span = Math.round((utcDay(weekEnd).getTime() - utcDay(weekStart).getTime()) / 86400000) + 1;
    if (utcDay(weekStart).getUTCDay() !== WEEK_START_DAY || span !== 7) {
      warnings.push(`Weekly Counts row ${r} (${track}) runs ${fmtISO(weekStart)} to ${fmtISO(weekEnd)}, which is not a Wednesday-to-Tuesday week. It was still used — check the dates if that wasn't deliberate.`);
    }

    out.push({
      weekStart: utcDay(weekStart),
      weekEnd: utcDay(weekEnd),
      track,
      received: num(row, c.received),
      closed: num(row, c.closed),
      onHold: num(row, c.onHold),
      wip: num(row, c.wip),
      auc: num(row, c.auc),
      aur: num(row, c.aur),
      am: num(row, c.am),
      open: num(row, c.open),
      carryForward: num(row, c.carry),
    });
  }
  return out;
}

function normalizeWorkstream(raw: unknown): Workstream | null {
  const s = norm(raw).toLowerCase();
  if (!s) return null;
  if (/dba|infra/.test(s)) return 'DBA & Infra';
  if (/fusion|scp/.test(s)) return 'Fusion SCP';
  if (/ebs|e-?business|oracle/.test(s)) return 'Oracle EBS';
  return null;
}

/** Section labels are matched loosely so "Work in progress", "WIP" and
 * "On Hold" all land in the right panel. */
function normalizeSection(raw: unknown): string {
  const s = norm(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return 'Updates';
  if (s.startsWith('update')) return 'Updates';
  if (s.startsWith('recommend') || s.includes('decision')) return 'Recommendations';
  if (s.startsWith('clos') || s.startsWith('complete')) return 'Closed';
  if (s === 'wip' || s.includes('workinprogress') || s.includes('inprogress')) return 'WIP';
  if (s.includes('onhold') || s.includes('hold') || s.includes('awaiting')) return 'On-Hold';
  return 'Others';
}

function parseActivities(wb: ExcelJS.Workbook): ActivityRow[] {
  const ws = sheet(wb, 'Activities', 'Activity');
  if (!ws) return [];
  const hdr = findHeaders(ws, ['Workstream', 'Section']) || findHeaders(ws, ['Track', 'Section']);
  if (!hdr) return [];
  const m = hdr.map;
  const cWs = pick(m, ['Workstream', 'Track']);
  const cSec = pick(m, ['Section']);
  const cDet = pick(m, ['Detail', 'Details', 'Description']);
  const cParent = pick(m, ['Sub-bullet of', 'Sub bullet of', 'Parent']);
  const out: ActivityRow[] = [];
  for (let r = hdr.rowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const workstream = normalizeWorkstream(cellText(cWs ? row.getCell(cWs).value : ''));
    const detail = norm(cellText(cDet ? row.getCell(cDet).value : ''));
    if (!workstream || !detail) continue;
    if (isExample(detail)) continue;
    const parent = cParent ? norm(cellText(row.getCell(cParent).value)) : '';
    out.push({ workstream, section: normalizeSection(cSec ? row.getCell(cSec).value : ''), detail, parent: parent || undefined });
  }
  return out;
}

function parseContacts(wb: ExcelJS.Workbook): ContactRow[] {
  const ws = sheet(wb, 'Contacts', 'Contact');
  if (!ws) return [];
  const hdr = findHeaders(ws, ['Name', 'Email']);
  if (!hdr) return [];
  const cN = pick(hdr.map, ['Name']), cE = pick(hdr.map, ['Email']);
  const out: ContactRow[] = [];
  for (let r = hdr.rowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = norm(cellText(cN ? row.getCell(cN).value : ''));
    const email = norm(cellText(cE ? row.getCell(cE).value : ''));
    if (!name || !email) continue;
    if (isExample(name)) continue;
    out.push({ name, email });
  }
  return out;
}

function parseSimple(wb: ExcelJS.Workbook, names: string[], cols: { title: string[]; detail: string[]; owner?: string[]; status?: string[]; due?: string[] }): SimpleRow[] {
  const ws = sheet(wb, ...names);
  if (!ws) return [];
  const hdr = findHeaders(ws, [cols.title[0], cols.detail[0]]);
  if (!hdr) return [];
  const m = hdr.map;
  const cT = pick(m, cols.title), cD = pick(m, cols.detail);
  const cO = cols.owner ? pick(m, cols.owner) : undefined;
  const cS = cols.status ? pick(m, cols.status) : undefined;
  const cDue = cols.due ? pick(m, cols.due) : undefined;
  const out: SimpleRow[] = [];
  for (let r = hdr.rowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const title = norm(cellText(cT ? row.getCell(cT).value : ''));
    const detail = norm(cellText(cD ? row.getCell(cD).value : ''));
    if (!title && !detail) continue;
    if (isExample(title, detail)) continue;
    const dueRaw = cDue ? row.getCell(cDue).value : null;
    const dueDate = cellDate(dueRaw);
    out.push({
      title: title || '—',
      detail,
      owner: cO ? norm(cellText(row.getCell(cO).value)) : undefined,
      status: cS ? norm(cellText(row.getCell(cS).value)) : undefined,
      due: dueDate ? dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : (cDue ? norm(cellText(dueRaw)) : undefined),
    });
  }
  return out;
}

/** True when nothing beyond the shipped examples has been entered anywhere. */
function data_isEmpty(wb: ExcelJS.Workbook): boolean {
  const names = ['Activities', 'Project Hours', 'Value Additions', 'Project Updates', 'Action Items', 'Help Needed', 'Contacts'];
  for (const n of names) {
    const ws = sheet(wb, n);
    if (!ws) continue;
    for (let r = 4; r <= ws.rowCount; r++) {   // rows 1-3 are title/help/header
      const row = ws.getRow(r);
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (c) => { cells.push(norm(cellText(c.value))); });
      if (!cells.some((c) => c)) continue;
      // An example row is identified by ANY cell carrying the marker, not by
      // the row as a whole starting with it — the marker sits on the text
      // column, which is rarely the first one.
      if (cells.some((c) => EXAMPLE_MARKER.test(c))) continue;
      return false;
    }
  }
  return true;
}

/**
 * @param window When the generate screen supplied a start and end date, that
 *   window wins over whatever the Report Info sheet says. The sheet's own
 *   dates stay as the fallback so an existing workbook still generates.
 */
export async function parseWeeklyReportWorkbook(buffer: Buffer, window?: ReportWindow | null): Promise<WeeklyReportData> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new Error('That file could not be opened as an Excel workbook. Save it as .xlsx and try again.');
  }
  if (wb.worksheets.length === 0) throw new Error('The workbook has no sheets in it.');

  const warnings: string[] = [];
  const info = parseInfo(wb, warnings);
  const { tickets, sections: ticketSections } = parseTickets(wb, warnings);
  const weeklyCounts = parseWeeklyCounts(wb, warnings);

  // The chosen week overrides the sheet. Say so when the two disagree, because
  // a report built for a different week than the one typed in the workbook is
  // exactly the kind of thing nobody notices until it has been sent.
  if (window) {
    const sheetStart = info.periodStart, sheetEnd = info.periodEnd;
    const differs = (a: Date | null, b: Date) => !a || utcDay(a).getTime() !== b.getTime();
    if ((sheetStart || sheetEnd) && (differs(sheetStart, window.start) || differs(sheetEnd, window.end))) {
      warnings.push(
        `The report was generated for ${fmtISO(window.start)} to ${fmtISO(window.end)}, the dates chosen on the generate screen. `
        + `The Report Info sheet says ${sheetStart ? fmtISO(sheetStart) : 'blank'} to ${sheetEnd ? fmtISO(sheetEnd) : 'blank'}, which was ignored.`,
      );
    }
    info.periodStart = window.start;
    info.periodEnd = window.end;
  }

  // Distinguish "this is the wrong file" from "this is the right file but
  // nobody filled it in" — the fix for each is completely different.
  const hasTicketsSheet = !!sheet(wb, 'Tickets', 'Ticket', 'Open Ticket');
  const hasInfoSheet = !!sheet(wb, 'Report Info', 'ReportInfo', 'Info');
  if (!hasTicketsSheet && !hasInfoSheet) {
    throw new Error('This doesn\'t look like the weekly report template — it has no "Tickets" or "Report Info" sheet. Download the template from the portal and fill that one in.');
  }
  if (tickets.length === 0 && weeklyCounts.length === 0 && !info.periodStart && data_isEmpty(wb)) {
    throw new Error('The template is still blank. Fill in the reporting period on "Report Info" and add your tickets, then upload it again.');
  }

  return {
    info,
    window: window ?? null,
    tickets,
    ticketSections,
    weeklyCounts,
    projectHours: parseProjectHours(wb),
    activities: parseActivities(wb),
    contacts: parseContacts(wb),
    valueAdditions: parseSimple(wb, ['Value Additions', 'ValueAdditions'], { title: ['Title'], detail: ['Detail'], owner: ['Benefit'] }),
    projectUpdates: parseSimple(wb, ['Project Updates', 'Projects'], { title: ['Project'], detail: ['Update'], status: ['Status'] }),
    actionItems: parseSimple(wb, ['Action Items', 'ActionItems'], { title: ['Action'], detail: ['Action'], owner: ['Owner'], status: ['Status'], due: ['Due Date'] }),
    helpNeeded: parseSimple(wb, ['Help Needed', 'HelpNeeded'], { title: ['Item'], detail: ['Detail'], owner: ['Owner'] }),
    warnings,
  };
}
