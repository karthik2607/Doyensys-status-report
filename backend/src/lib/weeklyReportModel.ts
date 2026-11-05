// ===========================================================================
// WEEKLY STATUS REPORT — shared vocabulary
//
// The source tracker this was built from carries the same value written many
// different ways: "4-Low", "4 - Low", "4-low", "4-LoW" are one priority;
// "Closed", "CLOSED", "CLosed", "closed" are one status. Counting rows by
// raw string would silently split each of those into separate buckets and
// produce a wrong report, so every value is normalised to a canonical form
// before anything is counted.
//
// The generated template locks these down with dropdowns so new data stays
// clean; the normaliser exists for the years of existing data that doesn't.
// ===========================================================================

export const TRACKS = ['Applications', 'Infra', 'DBA'] as const;
export type Track = (typeof TRACKS)[number];

// The rows of the "Tickets Classification" table in the report. This is a
// different grouping from Track — a ticket has both.
export const REPORT_CATEGORIES = ['Change', 'Fusion', 'EBS', 'Projects'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

// The written sections of the report are grouped by workstream, which is a
// third grouping again: the summary table counts by Track, the classification
// table counts by Report Category, and the narrative is organised by these.
export const WORKSTREAMS = ['DBA & Infra', 'Fusion SCP', 'Oracle EBS'] as const;
export type Workstream = (typeof WORKSTREAMS)[number];

export const ACTIVITY_SECTIONS = ['Updates', 'Recommendations', 'Closed', 'WIP', 'On-Hold', 'Others'] as const;

export const PRIORITIES = ['P1 - Critical', 'P2 - High', 'P3 - Medium', 'P4 - Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUSES = [
  'Open',
  'Work in Progress',
  'Hold',
  'Awaiting User Confirmation',
  'Awaiting User Response',
  'Awaiting Migration',
  'Closed',
  'Transferred',
] as const;
export type TicketStatus = (typeof STATUSES)[number];

/** The short labels the report's Tickets Classification table uses as column
 * headings, with the footnote that explains each. Received and Closed are not
 * statuses — they are counted from dates — so they are not in this map. */
export const STATUS_ABBR: { status: TicketStatus; abbr: string; full: string }[] = [
  { status: 'Hold', abbr: 'On Hold', full: 'On Hold' },
  { status: 'Work in Progress', abbr: 'WIP', full: 'Work in Progress' },
  { status: 'Awaiting User Confirmation', abbr: 'AUC', full: 'Awaiting User Confirmation' },
  { status: 'Awaiting User Response', abbr: 'AUR', full: 'Awaiting User Response' },
  { status: 'Awaiting Migration', abbr: 'AM', full: 'Awaiting Migration' },
  { status: 'Open', abbr: 'Open', full: 'Open' },
];

export const TICKET_TYPES = [
  'Issue',
  'Change',
  'User Query',
  'Access / Login',
  'Data Load',
  'Data Fix',
  'Error Correction',
  'Other',
] as const;

/** Statuses that mean the ticket is finished and should stop counting
 * towards open/carry-forward. */
export const CLOSED_STATUSES: readonly string[] = ['Closed', 'Transferred'];

function squash(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** "4 - Low" / "4-low" / "P4" / "Low" -> "P4 - Low". Unknown values fall back
 * to P4 rather than being dropped: a ticket with a nonsense priority should
 * still appear in the report, just in the lowest bucket. */
export function normalizePriority(raw: unknown): Priority {
  const s = squash(raw).toLowerCase();
  if (!s) return 'P4 - Low';
  // Leading digit is the most reliable signal in the source data.
  const digit = s.match(/^\s*(?:p)?\s*([1-4])\b/);
  if (digit) {
    return PRIORITIES[Number(digit[1]) - 1];
  }
  if (/crit|sev\s*1|urgent|blocker/.test(s)) return 'P1 - Critical';
  if (/high|heigh/.test(s)) return 'P2 - High';       // "2-Heigh" is in the real data
  if (/med/.test(s)) return 'P3 - Medium';
  if (/low/.test(s)) return 'P4 - Low';
  return 'P4 - Low';
}

export function normalizeStatus(raw: unknown): TicketStatus {
  const s = squash(raw).toLowerCase();
  if (!s) return 'Open';
  if (/^clos|^closed/.test(s)) return 'Closed';
  // "Resolved" is how the tracker marks a finished ticket. Without this it fell
  // through to "Open", so a week's closed tickets counted as still open.
  if (/^resolv|^complet|^done\b|^fixed\b/.test(s)) return 'Closed';
  if (/transfer|trasfer/.test(s)) return 'Transferred';          // "Trasfered" is in the real data
  // Must be tested before the "await" rule below: "Awaiting Migration" contains
  // "awaiting" and would otherwise be swallowed into the AUC bucket.
  if (/migrat/.test(s)) return 'Awaiting Migration';
  if (/work\s*in\s*progress|^wip\b|in progress/.test(s)) return 'Work in Progress';
  if (/hold/.test(s)) return 'Hold';
  // AUR and AUC are reported separately, so "response" has to be tested before
  // the general awaiting rule. "Awating User Response" (sic) is in the real
  // data, which is why the spelling is matched loosely.
  if (/user\s*response|\baur\b/.test(s)) return 'Awaiting User Response';
  if (/user\s*confirm|\bauc\b/.test(s)) return 'Awaiting User Confirmation';
  if (/await|awat/.test(s)) return 'Awaiting User Confirmation';
  if (/removed|cancel/.test(s)) return 'Closed';
  return 'Open';
}

export function normalizeTrack(raw: unknown): Track | null {
  const s = squash(raw).toLowerCase();
  if (!s) return null;
  if (/^app|erp|fusion|ebs/.test(s)) return 'Applications';
  if (/^infra|azure|network|server|cloud/.test(s)) return 'Infra';
  if (/^dba|database|^db\b|oracle db/.test(s)) return 'DBA';
  return null;
}

/** Best guess at a track from the module name, used only to pre-fill the
 * Track column when a row leaves it blank. The person filling the sheet can
 * always override it, which is why a wrong guess here is recoverable. */
export function guessTrackFromModule(moduleName: unknown): Track {
  const s = squash(moduleName).toLowerCase();
  if (/dba|database|rman|asm|datapump|19c|upgrade|patch/.test(s)) return 'DBA';
  if (/infra|azure|aws|network|vpn|server|storage|backup|os |linux|windows|firewall/.test(s)) return 'Infra';
  return 'Applications';
}

export function normalizeReportCategory(raw: unknown, type?: unknown, moduleName?: unknown): ReportCategory {
  const s = squash(raw).toLowerCase();
  if (/fusion|scp/.test(s)) return 'Fusion';
  if (/ebs|e-?business/.test(s)) return 'EBS';
  if (/project/.test(s)) return 'Projects';
  if (/change/.test(s)) return 'Change';
  // Blank: fall back to the ticket's own type and module, which is the best
  // signal available without asking the person to re-key every row.
  const t = squash(type).toLowerCase();
  const m = squash(moduleName).toLowerCase();
  if (/fusion|scp/.test(m)) return 'Fusion';
  if (/^change$/.test(t)) return 'Change';
  if (/project/.test(m)) return 'Projects';
  return 'EBS';
}

export function isClosed(status: TicketStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Open tickets
//
//   Open tickets = WIP + Open + AUC + AUR + AM + Hold
//
// A headcount of tickets by current status, per track. It is the team's own
// definition of "Total Open Tickets". Carry-forward is a separate figure that
// is typed by hand and never derived from this or anything else.
// ---------------------------------------------------------------------------

/** The statuses that add up to "Open tickets". */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'Work in Progress',            // WIP
  'Open',                        // OPEN
  'Awaiting User Confirmation',  // AUC
  'Awaiting User Response',      // AUR
  'Awaiting Migration',          // AM
  'Hold',                        // HOLD
];

/** Open tickets for a set of ticket rows. */
export function countOpenTickets(tickets: { status: TicketStatus }[]): number {
  return tickets.filter((t) => OPEN_TICKET_STATUSES.includes(t.status)).length;
}

/** The same formula for a Weekly Counts row, where the six status columns were
 * typed instead of counted. A blank cell counts as zero; returns null only when
 * all six are blank, meaning nothing was entered for this week at all. */
export function openFromCounts(row: {
  wip: number | null; open: number | null; auc: number | null;
  aur: number | null; am: number | null; onHold: number | null;
}): number | null {
  const parts = [row.wip, row.open, row.auc, row.aur, row.am, row.onHold];
  if (parts.every((p) => p === null)) return null;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Reporting windows
//
// The reporting week runs Wednesday 00:00 to the following Tuesday, so a week
// is identified by its Wednesday. Everything is done in UTC: the dates come
// out of a spreadsheet with no timezone attached, and shifting them by a local
// offset is how a ticket ends up in the wrong week.
// ---------------------------------------------------------------------------

/** Day-of-week the reporting week starts on. 3 = Wednesday. */
export const WEEK_START_DAY = 3;

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The Wednesday on or before `d`. */
export function startOfReportWeek(d: Date): Date {
  const x = utcDay(d);
  const back = (x.getUTCDay() - WEEK_START_DAY + 7) % 7;
  return addDays(x, -back);
}

/** The Tuesday that closes the week `d` falls in. */
export function endOfReportWeek(d: Date): Date {
  return addDays(startOfReportWeek(d), 6);
}

export type ReportGranularity = 'week' | 'month';

export interface ReportWindow {
  start: Date;
  end: Date;
  granularity: ReportGranularity;
}

/** Builds a window from two dates, or explains why they are not one.
 *
 * Only a single Wednesday-to-Tuesday week is accepted today. The shape is
 * deliberately granularity-tagged so a month can be allowed later by adding a
 * branch here rather than by unpicking every caller. */
export function makeReportWindow(start: Date | null, end: Date | null): { window: ReportWindow } | { error: string } {
  if (!start || !end) return { error: 'Both a start date and an end date are needed.' };
  const a = utcDay(start), b = utcDay(end);
  if (b.getTime() < a.getTime()) return { error: 'The end date falls before the start date.' };

  const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
  if (a.getUTCDay() !== WEEK_START_DAY || days !== 7) {
    return {
      error: 'Reports are generated one week at a time, and the reporting week runs Wednesday to Tuesday. '
        + `Pick a Wednesday start date and the Tuesday six days after it — for the week containing ${fmtISO(a)} that is `
        + `${fmtISO(startOfReportWeek(a))} to ${fmtISO(endOfReportWeek(a))}.`,
    };
  }
  return { window: { start: a, end: b, granularity: 'week' } };
}

export function fmtISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** True when the two dates describe the same reporting window. Used to match a
 * Weekly Counts row to the week being reported. */
export function sameWindow(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return utcDay(a.start).getTime() === utcDay(b.start).getTime()
    && utcDay(a.end).getTime() === utcDay(b.end).getTime();
}

// ---------------------------------------------------------------------------
// The parsed shape of a filled-in template
// ---------------------------------------------------------------------------

export interface ReportTicket {
  ticketId: string;
  reportCategory: ReportCategory;
  summary: string;
  track: Track;
  priority: Priority;
  type: string;
  module: string;
  status: TicketStatus;
  assignedTo: string;
  requestor: string;
  openDate: Date | null;
  closedDate: Date | null;
  slaDays: number | null;
}

/** One week's block on the Tickets sheet: the dates and per-track carry-forward
 * from its banner row, plus the ticket rows filed under it.
 *
 * A section is what makes a week's ticket data self-describing. Without one,
 * the only way to say which tickets belong to a week is to filter the whole
 * sheet by date — which silently pulls in older still-open tickets that happen
 * to overlap, and reports a partial week as a complete one. */
export interface TicketSection {
  start: Date | null;
  end: Date | null;
  /** Typed per track on the banner. Missing means blank, never zero. */
  carryForward: Partial<Record<Track, number>>;
  tickets: ReportTicket[];
  /** Row the banner sits on, for warnings that have to name a place. */
  rowNumber: number;
}

/** One typed row of the Weekly Counts sheet: a whole week's numbers for one
 * track, without any ticket-level detail behind them.
 *
 * Carry-forward is read from here for EVERY week, including weeks that do have
 * ticket detail. It is never derived — two sources for one number is how a
 * report ends up disagreeing with itself. */
export interface WeeklyCountRow {
  weekStart: Date;
  weekEnd: Date;
  track: Track;
  received: number | null;
  closed: number | null;
  onHold: number | null;
  wip: number | null;
  auc: number | null;
  aur: number | null;
  am: number | null;
  open: number | null;
  carryForward: number | null;
}

export interface ProjectHoursRow {
  track: Track;
  activity: string;
  hours: number;
  month: string;
}

export interface ActivityRow {
  workstream: Workstream;
  /** Closed | WIP | On-Hold | Others | Updates | Recommendations */
  section: string;
  detail: string;
  /** When set, this row renders as an indented bullet under the row whose
   * detail matches it — the nested sub-lists in the report. */
  parent?: string;
}

export interface SimpleRow {
  title: string;
  detail: string;
  owner?: string;
  status?: string;
  due?: string;
  parent?: string;
}

export interface ContactRow {
  name: string;
  email: string;
}

export interface ReportInfo {
  customer: string;
  reportTitle: string;
  reportSubtitle: string;
  teamName: string;
  snapshotSummary: string;
  dbaInfraSummary: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  meetingDate: Date | null;
  preparedBy: string;
  customerParticipants: string;
  doyensysParticipants: string;
  scope: string;
  keyHighlights: string[];
}

export interface WeeklyReportData {
  info: ReportInfo;
  /** The window the report covers. Comes from the dates chosen on the generate
   * screen when they are supplied, otherwise from the Report Info sheet. */
  window: ReportWindow | null;
  /** Every ticket in the workbook, across all week sections. */
  tickets: ReportTicket[];
  /** The Tickets sheet broken into its week sections. Empty when the sheet is
   * a single undivided block, which older filled-in files still are. */
  ticketSections: TicketSection[];
  /** Typed per-week, per-track numbers for the weeks that have no ticket
   * detail at all. Supplies their whole trend series and carry-forward. */
  weeklyCounts: WeeklyCountRow[];
  projectHours: ProjectHoursRow[];
  activities: ActivityRow[];
  contacts: ContactRow[];
  valueAdditions: SimpleRow[];
  projectUpdates: SimpleRow[];
  actionItems: SimpleRow[];
  helpNeeded: SimpleRow[];
  /** Non-fatal problems worth telling the user about after a successful parse. */
  warnings: string[];
}
