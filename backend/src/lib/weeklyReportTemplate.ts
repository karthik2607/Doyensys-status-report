import ExcelJS from 'exceljs';
import { TRACKS, PRIORITIES, STATUSES, TICKET_TYPES, REPORT_CATEGORIES, WORKSTREAMS, ACTIVITY_SECTIONS } from './weeklyReportModel';

// ===========================================================================
// WEEKLY STATUS REPORT — the fill-in template
//
// One workbook that produces the whole report. Each sheet maps to a section
// of the generated document, and the header row of every sheet is what the
// parser matches on, so the two files have to stay in step — the column
// names here are the contract.
//
// Dropdowns (Excel data validation) are applied down each constrained column
// rather than left as free text. The tracker this replaces accumulated 16
// spellings of 4 priorities and 14 of 6 statuses precisely because nothing
// stopped people typing; a locked list is the only thing that actually
// prevents that.
// ===========================================================================

const INK = 'FF1B1F27';
const RED = 'FFF4051C';
const GREY_BG = 'FFF0F1F3';
const WHITE = 'FFFFFFFF';

/** A generous row count for the validation range: the dropdown must still be
 * there when someone pastes in a year of tickets, and empty rows carry no
 * cost in the saved file. */
const VALIDATION_ROWS = 2000;

function titleRow(ws: ExcelJS.Worksheet, text: string, span: number) {
  const row = ws.addRow([text]);
  ws.mergeCells(row.number, 1, row.number, span);
  const cell = row.getCell(1);
  cell.font = { bold: true, size: 13, color: { argb: WHITE } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  cell.alignment = { vertical: 'middle', indent: 1 };
  row.height = 24;
}

/** Said on every data sheet: the generator never turns an empty cell into 0. */
const EMPTY_NOT_ZERO = 'NOTE: Leaving a cell empty is NOT taken as zero — an empty cell is left blank in the report and is never counted as 0. Type 0 if you mean zero.';

function helpRow(ws: ExcelJS.Worksheet, text: string, span: number) {
  const row = ws.addRow([`${text}\n${EMPTY_NOT_ZERO}`]);
  ws.mergeCells(row.number, 1, row.number, span);
  const cell = row.getCell(1);
  cell.font = { italic: true, size: 10, color: { argb: 'FF6B7280' } };
  cell.alignment = { vertical: 'middle', indent: 1, wrapText: true };
  // Room for the sheet's own help plus the empty-cell note. Long help text on
  // a narrow sheet wraps onto more lines, so size by length.
  row.height = Math.min(150, 30 + Math.ceil(text.length / 110) * 14);
}

function headerRow(ws: ExcelJS.Worksheet, headers: string[]) {
  const row = ws.addRow(headers);
  row.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: INK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY_BG } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: RED } } };
  });
  row.height = 28;
  return row;
}

/** Attaches a dropdown to a whole column range in one go.
 *
 * This deliberately writes a single range entry rather than looping over
 * cells. Touching `getCell()` on 2000 rows materialises every one of them,
 * which pushes `rowCount` to ~2003 — and `addRow()` then appends *below*
 * that, so filled-in data landed on row 2004 and the sheet looked empty.
 * A range entry attaches the same validation to the same cells while the
 * sheet still has only its three header rows.
 *
 * errorStyle must be one of stop | warning | information. "error" is not a
 * value in the spec and makes stricter readers reject the file outright. */
function addDropdown(ws: ExcelJS.Worksheet, colLetter: string, firstDataRow: number, values: readonly string[]) {
  // Excel caps an inline list at 255 characters — all our lists are well
  // inside that, so there's no need for a hidden lookup sheet.
  const formula = `"${values.join(',')}"`;
  const lastRow = firstDataRow + VALIDATION_ROWS - 1;
  (ws as unknown as { dataValidations: { model: Record<string, unknown> } })
    .dataValidations.model[`${colLetter}${firstDataRow}:${colLetter}${lastRow}`] = {
      type: 'list',
      allowBlank: true,
      formulae: [formula],
      showErrorMessage: true,
      errorStyle: 'stop',
      errorTitle: 'Pick from the list',
      error: `Choose one of: ${values.join(', ')}`,
    };
}

/** Date formatting applied to the column rather than cell by cell, for the
 * same reason as above — a per-cell loop would inflate the row count. */
function dateFormat(ws: ExcelJS.Worksheet, colLetter: string, _firstDataRow: number) {
  ws.getColumn(colLetter).numFmt = 'dd-mmm-yyyy';
}

export async function buildWeeklyReportTemplate(opts?: { customer?: string }): Promise<Buffer> {
  const customer = opts?.customer || 'Customer';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Doyensys Customer Portal';
  wb.created = new Date();

  // ---------------------------------------------------------------- README
  const readme = wb.addWorksheet('README', { properties: { tabColor: { argb: RED } } });
  readme.columns = [{ width: 110 }];
  titleRow(readme, 'Doyensys — Weekly Status Report Template', 1);
  [
    '',
    'EMPTY CELLS ARE NOT ZERO',
    'Leaving a cell empty is NOT taken as zero, on any sheet. An empty cell is left blank in the report — it is',
    'never counted, charted or totalled as 0. If the figure really is zero, type 0.',
    '',
    'HOW TO USE THIS FILE',
    '1. Fill in every sheet that applies. Blank sheets are simply left out of the report.',
    '2. Columns with a dropdown must use the dropdown — typing your own value will be rejected by Excel.',
    '   Rows written in grey italics starting with "EXAMPLE - " are samples. Delete them, or leave them:',
    '   anything starting with EXAMPLE is ignored when the report is generated, so it can never reach a customer.',
    '3. Paste your ticket export into the Tickets sheet. Keep the header row exactly as it is.',
    '4. Save the file, then upload it in the portal under Status Reports → Generate from Excel,',
    '   and choose the week’s start and end date on that screen.',
    '5. Review the preview, download the report, then upload it against the right date.',
    '',
    'THE REPORTING WEEK',
    'A reporting week runs WEDNESDAY to TUESDAY. The week of 07-Oct-2026, for example, is 07-Oct to 13-Oct.',
    'Reports are generated one week at a time: the start date must be a Wednesday and the end date the',
    'Tuesday six days later. Anything else is refused with a message telling you the right pair of dates.',
    '',
    'TWO WAYS TO SUPPLY A WEEK — USE ONE OR THE OTHER, NEVER BOTH',
    'Ticket detail .... Add a section for the week on the TICKETS sheet and paste that week’s tickets into',
    '                   it. This is how 07-Oct-2026 onwards works.',
    'Counts only ...... For older weeks, where no ticket-level export exists, type the totals per track on',
    '                   the WEEKLY COUNTS sheet instead. Those weeks still appear on the trend charts.',
    'If a week ends up in both places the Tickets section is used and the generator tells you the Weekly',
    'Counts row for that week is redundant, so it can be deleted.',
    '',
    'HOW A WEEK SECTION ON THE TICKETS SHEET IS LAID OUT',
    'Each week is a self-contained block of three parts, one after another down the sheet:',
    '  1. A BANNER ROW: Start Date | <date> | End Date | <date> | Carryforward Applications | <n> |',
    '     Carryforward Infra | <n> | Carryforward DBA | <n>',
    '  2. The column header row (Assigned To Technician, Ticket Id, Priority, …, Track, Report Category).',
    '  3. That week’s ticket rows, pasted straight from the tracker.',
    'A blank row closes a section. To add a week, copy an entire section — banner, headers and rows — paste',
    'it below the last one and change the dates. The template ships with one worked example section and one',
    'empty section ready to fill in.',
    'Only the section whose dates match the week you pick on the generate screen is counted as this week.',
    '',
    'WHICH NUMBER WINS',
    'The week’s own source wins. A week with a Tickets section is counted from its ticket rows, and its',
    'carry-forward comes from that section’s banner. A week with only a Weekly Counts row takes every',
    'figure, carry-forward included, from that row.',
    'This separation matters because the Tickets sheet also holds older still-open tickets as backlog:',
    'counting a past week from those rows would publish a partial week as though it were the whole week.',
    '',
    'WHAT EACH SHEET DOES',
    'Report Info ........ Title, participants, and the key highlights at the top of the report.',
    'Tickets ............ One row per ticket. Drives this week’s numbers, tables and the written detail.',
    'Weekly Counts ...... One row per week per track. Supplies the trend charts for weeks with no ticket',
    '                     detail, and supplies Carryforward for EVERY week.',
    'Project Hours ...... Hours per track. Aug–Oct 2026 are pre-filled monthly rows; from November 2026 add one row',
    '                     per track per week (Week Start / Week End). Months are running totals of their weeks; the',
    '                     report shows the last three months and this week’s rows in the weekly summary.',
    'Activities ......... The written updates per track (Closed / WIP / On-Hold / Others / Updates / Recommendations).',
    'Value Additions .... Initiatives and improvements delivered outside of ticket work.',
    'Project Updates .... Status of ongoing projects.',
    'Action Items ....... Open actions with owner and due date.',
    'Help Needed ........ Anything blocked on the customer or a third party.',
    '',
    'ABOUT THE TRACK COLUMN',
    'Every ticket needs a Track (Applications, Infra or DBA) because the report is organised that way.',
    'If you leave Track blank it is guessed from the Module name, and the report tells you how many rows were guessed.',
    'Checking those rows is worth the minute it takes — a wrong track moves a ticket into the wrong section.',
    '',
    'ABOUT THE STATUS COLUMN',
    'The Status column is read as written in your export, then matched to one of these:',
    `   ${STATUSES.join('  |  ')}`,
    'Resolved, Completed, Done and Fixed all count as Closed.',
    'The report shows them as: Received | Closed | On Hold | WIP | AUC | AUR | AM | Open, where',
    '   AUC = Awaiting User Confirmation, AUR = Awaiting User Response, AM = Awaiting Migration.',
    'AUC and AUR are counted separately, so "Awaiting User Response" no longer lands in the AUC column.',
    'Common misspellings are handled (Awating User Response, Trasfered, CLosed), so paste the export as it is.',
    '',
    'ABOUT DATES',
    'Received and Closed come from Open Date and Closed Date compared against the week you select on the',
    'generate screen. If those dates are missing, the ticket still appears in the report but cannot be',
    'counted as received or closed in the week.',
    '',
    'ABOUT OPEN TICKETS',
    'The "Open tickets" column is calculated: WIP + Open + AUC + AUR + AM + Hold, counted from the week\u2019s',
    'ticket statuses per track. For a counts-only week the same six columns on Weekly Counts are added up.',
    'You never type it. Carryforward is separate and is typed by hand.',
    '',
    'ABOUT CARRYFORWARD',
    'Carryforward is NEVER calculated. You type the figure you want published, in the same place the rest',
    'of that week’s data lives:',
    '   a week with ticket detail .... the three Carryforward fields on that section’s banner row',
    '   a counts-only week ........... the Carryforward column on the Weekly Counts sheet',
    'If a week has no Carryforward for a track, that cell is left blank in the report and the generator',
    'tells you which week and track it was missing.',
  ].forEach((line) => {
    const r = readme.addRow([line]);
    const c = r.getCell(1);
    c.alignment = { wrapText: false, indent: 1 };
    if (/^[A-Z][A-Z ]+$/.test(line.trim()) && line.trim().length > 3) {
      c.font = { bold: true, size: 11, color: { argb: RED } };
    } else {
      c.font = { size: 10.5, color: { argb: 'FF374151' } };
    }
  });

  // ----------------------------------------------------------- Report Info
  const info = wb.addWorksheet('Report Info');
  info.columns = [{ width: 30 }, { width: 80 }];
  titleRow(info, 'Report Information', 2);
  helpRow(info, 'Fill in the right-hand column. Reporting Period Start / End are a fallback only — the dates you choose on the generate screen win when they are supplied. The week runs Wednesday to Tuesday.', 2);
  headerRow(info, ['Field', 'Value']);
  const infoFields: [string, string | Date][] = [
    ['Customer', customer],
    ['Report Title', 'Weekly Status Update'],
    ['Report Subtitle', 'Managed Services'],
    ['Team Name', 'Team: Applications & Infra Support'],
    ['Snapshot Summary', 'Overall it\u2019s been support as usual with no Critical / major issues being reported.'],
    ['DBA & Infra Summary', 'Team had a routine support activities for the week.'],
    ['Reporting Period Start', ''],
    ['Reporting Period End', ''],
    ['Meeting Date', ''],
    ['Prepared By', ''],
    ['Customer Participants', ''],
    ['Doyensys Participants', ''],
    ['Scope', 'Support (Applications, Infra, DBA), Projects'],
    ['Key Highlight 1', ''],
    ['Key Highlight 2', ''],
    ['Key Highlight 3', ''],
    ['Key Highlight 4', ''],
    ['Key Highlight 5', ''],
  ];
  infoFields.forEach(([label, value]) => {
    const r = info.addRow([label, value]);
    r.getCell(1).font = { bold: true, size: 10.5 };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFB' } };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.height = 20;
    if (/Date|Period/.test(label)) r.getCell(2).numFmt = 'dd-mmm-yyyy';
  });

  // --------------------------------------------------------------- Tickets
  // Columns A-V mirror the TrackIT export exactly, in its own order and with
  // its own spellings (including "Secuirty Concern" and the two separate
  // Status columns), so a whole export pastes into A2 and lines up with no
  // re-arranging. The only two columns anyone has to fill by hand — Track and
  // Report Category — are appended at the far right, past the pasted block.
  const tickets = wb.addWorksheet('Tickets');
  const ticketHeaders = [
    'Assigned To Technician', 'Ticket Id', 'Priority', 'Type', 'Module', 'Status',
    'Assigned To', 'Open Date', 'Expected Date', 'Closed Date', 'Secuirty Concern',
    'no of days delay (SLA)', 'Period', 'Ticket Summary', 'Requestor',
    'Petmate Week', 'Venkat-Week', '', 'Status', 'Category', '', 'Assigned to Group',
    'Track', 'Report Category',
  ];
  tickets.columns = [
    { width: 20 }, { width: 10 }, { width: 12 }, { width: 16 }, { width: 20 }, { width: 20 },
    { width: 14 }, { width: 13 }, { width: 14 }, { width: 13 }, { width: 15 },
    { width: 17 }, { width: 12 }, { width: 46 }, { width: 20 },
    { width: 13 }, { width: 13 }, { width: 4 }, { width: 10 }, { width: 18 }, { width: 4 }, { width: 22 },
    { width: 15 }, { width: 17 },
  ];
  titleRow(tickets, 'Tickets — one section per reporting week', ticketHeaders.length);
  helpRow(tickets, 'Each week is its own section: a banner row carrying that week\'s Start Date, End Date and the Carryforward per track, then the column headers, then that week\'s tickets. Columns A-V are exactly your tracker\'s columns in the same order, so select the rows in your export (not the header) and paste them under the headers of the right section. Then fill only the last two columns: Track and Report Category. To add a week, copy a whole section — banner, headers and all — and change the dates.', ticketHeaders.length);

  // Dropdowns go only on the two hand-filled columns. Putting them on the
  // pasted columns would achieve nothing — Excel does not apply validation to
  // pasted cells — while blocking anyone typing a value their own tracker
  // uses. Those columns are normalised on import instead.
  //
  // These are set on whole columns, which now span every section — that works
  // because every section repeats the same column layout.
  addDropdown(tickets, 'W', 4, TRACKS);
  addDropdown(tickets, 'X', 4, REPORT_CATEGORIES);
  dateFormat(tickets, 'H', 4);   // Open Date
  dateFormat(tickets, 'I', 4);   // Expected Date
  dateFormat(tickets, 'J', 4);   // Closed Date

  // Tint the two hand-filled columns so they stand out from the pasted block.
  // Set on the column, not cell by cell — a per-cell loop would inflate the
  // row count and push appended rows far down the sheet.
  for (const col of ['W', 'X']) {
    tickets.getColumn(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };
  }

  /** The banner that opens a week's section: label/value pairs across one row.
   *
   * The labels are what the parser matches on, so each value sits in the cell
   * immediately to the right of its label. Carryforward is one field per
   * track, typed by hand and never derived.
   *
   * Two of those value cells land in columns H and J, which carry a
   * dd-mmm-yyyy format for Open Date and Closed Date further down the sheet.
   * A column format would turn a carryforward of 32 into a date, so every
   * banner cell sets its own format explicitly — a cell format wins over a
   * column one. */
  function weekBanner(start: Date | null, end: Date | null, carry: Partial<Record<string, number>>) {
    const cells: [string, unknown, string][] = [
      ['Start Date', start, 'dd-mmm-yyyy'],
      ['End Date', end, 'dd-mmm-yyyy'],
      ...TRACKS.map((t) => [`Carryforward ${t}`, carry[t] ?? null, 'General'] as [string, unknown, string]),
    ];
    const values: unknown[] = [];
    for (const [label, value] of cells) values.push(label, value);
    const row = tickets.addRow(values);
    row.height = 22;
    cells.forEach(([, , fmt], i) => {
      const labelCell = row.getCell(i * 2 + 1);
      const valueCell = row.getCell(i * 2 + 2);
      labelCell.font = { bold: true, size: 10.5, color: { argb: WHITE } };
      labelCell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
      valueCell.font = { bold: true, size: 10.5, color: { argb: INK } };
      valueCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      valueCell.numFmt = fmt;
      valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };
    });
    // Fill the whole banner row so the section boundary is unmissable.
    for (let c = 1; c <= ticketHeaders.length; c++) {
      const cell = row.getCell(c);
      if (!cell.fill || (cell.fill as { fgColor?: { argb?: string } }).fgColor?.argb !== 'FFFFF7E6') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
      }
    }
    return row;
  }

  function blankRow() { tickets.addRow([]).height = 8; }

  // Section 1 — a worked example, so the shape is obvious before anyone types.
  weekBanner(new Date('2026-10-07'), new Date('2026-10-13'), { Applications: 32, Infra: 0, DBA: 0 });
  headerRow(tickets, ticketHeaders);
  tickets.addRow(['D', 2286, '4-Low', 'Change', 'Fusion SCP', 'Work in Progress', 'Sangeetha',
    new Date('2026-10-08'), new Date('2026-10-20'), null, 'No', null, 'Oct-2026',
    'EXAMPLE - Fusion Improvement Request — supply plan exceptions', 'Kati Wagler',
    null, null, null, 'OPEN', 'Application - ERP', null, 'Venkatesh Balasubramanian',
    'Applications', 'Fusion']);
  tickets.addRow(['D', 3755, '4 - Low', 'Issue', 'Receivables', 'Closed', 'Vishnu',
    new Date('2026-10-09'), new Date('2026-10-10'), new Date('2026-10-12'), 'No', 2, 'Oct-2026',
    'EXAMPLE - RE: 1405 Raw Inspection receipt mismatch', 'Jeffrey Welsh',
    null, null, null, 'OPEN', 'Application - ERP', null, 'Venkatesh Balasubramanian',
    'Applications', 'EBS']);
  blankRow();

  // Section 2 — empty and ready for next week, so adding one is filling in
  // dates rather than working out what a section is meant to look like.
  weekBanner(null, null, {});
  headerRow(tickets, ticketHeaders);
  blankRow();

  // Only the title and help rows are frozen: the headers repeat per section,
  // so freezing the first set would pin one week's headers over every other.
  // An autofilter is deliberately absent for the same reason — it spans one
  // contiguous block, and this sheet is many.
  tickets.views = [{ state: 'frozen', ySplit: 2, xSplit: 2 }];

  // --------------------------------------------------------- Weekly Counts
  // The history sheet. Ticket-level detail only exists from the week of
  // 07-Oct-2026 onwards; for every week before that all anyone has is a set of
  // totals per track. Rather than pretend otherwise, those totals are typed
  // here and the trend charts read from them.
  //
  // The dates typed on each row ARE the window — nothing is snapped to a
  // calendar grid. A short week over a holiday is therefore just a row with
  // dates that are closer together, not a special case in the code.
  const counts = wb.addWorksheet('Weekly Counts');
  const countHeaders = [
    'Week Start', 'Week End', 'Track',
    'Received', 'Closed', 'On Hold', 'WIP', 'AUC', 'AUR', 'AM', 'Open', 'Carryforward',
  ];
  counts.columns = [
    { width: 14 }, { width: 14 }, { width: 16 },
    { width: 11 }, { width: 10 }, { width: 10 }, { width: 8 }, { width: 8 },
    { width: 8 }, { width: 8 }, { width: 9 }, { width: 15 },
  ];
  titleRow(counts, 'Weekly Counts — ONLY for weeks with no ticket-level data', countHeaders.length);
  helpRow(counts, 'This sheet is for the older weeks where no ticket export exists. Do NOT fill it in for a week that has a section on the Tickets sheet — that week is counted from its tickets, and a row here for it is redundant. Fill one row per track for each counts-only week; the eight most recent weeks across both sheets are charted. The reporting week runs Wednesday to Tuesday, and Carryforward is typed, never calculated.', countHeaders.length);
  headerRow(counts, countHeaders);
  const countsFirst = counts.rowCount + 1;
  addDropdown(counts, 'C', countsFirst, TRACKS);
  dateFormat(counts, 'A', countsFirst);
  dateFormat(counts, 'B', countsFirst);

  // Carryforward is the one number nothing else can supply, so it is tinted
  // the same way the hand-filled ticket columns are.
  counts.getColumn('L').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E6' } };

  // A complete week across all three tracks, so the expected shape is obvious.
  // These carry the EXAMPLE marker in the Track cell, which is what the parser
  // checks, so they never reach a report.
  const exampleWeek: [Date, Date] = [new Date('2026-09-30'), new Date('2026-10-06')];
  ([
    ['EXAMPLE - Applications', 9, 6, 2, 18, 1, 2, 1, 0, 26],
    ['EXAMPLE - Infra', 3, 3, 0, 0, 0, 0, 0, 0, 0],
    ['EXAMPLE - DBA', 4, 4, 0, 0, 0, 0, 0, 0, 0],
  ] as [string, number, number, number, number, number, number, number, number, number][])
    .forEach(([track, received, closed, onHold, wip, auc, aur, am, open, carry]) => {
      const r = counts.addRow([exampleWeek[0], exampleWeek[1], track, received, closed, onHold, wip, auc, aur, am, open, carry]);
      r.eachCell((cell) => { cell.font = { italic: true, size: 10, color: { argb: 'FF9AA0AC' } }; });
    });
  counts.views = [{ state: 'frozen', ySplit: 3, xSplit: 3 }];

  // --------------------------------------------------------- Project Hours
  // Two kinds of row: MONTHLY history rows (Month filled, no week dates) and,
  // from November 2026, WEEKLY rows (Week Start + Week End filled). A month's
  // figure is the running total of its weekly rows; a week counts toward the
  // month its Week End (the Tuesday) falls in. The report shows the last three
  // months. Aug–Oct 2026 come pre-filled as monthly rows — keep them.
  const hours = wb.addWorksheet('Project Hours');
  const hoursHeaders = ['Track', 'Activity', 'Hours', 'Month', 'Week Start', 'Week End'];
  hours.columns = [{ width: 16 }, { width: 52 }, { width: 10 }, { width: 14 }, { width: 14 }, { width: 14 }];
  titleRow(hours, 'Project Hours', hoursHeaders.length);
  helpRow(hours, 'Hours spent on project (non-ticket) work. MONTHLY rows (Aug-2026 to Oct-2026, already filled in — keep them): fill Month, leave the week dates empty. From November 2026 add one WEEKLY row per track per week: fill Week Start and Week End (Wednesday to Tuesday) and leave Month empty — the week counts toward the month its Week End falls in, and each month is the running total of its weeks. The report shows the last three months, and the weekly summary shows only the rows for the week being reported.', hoursHeaders.length);
  headerRow(hours, hoursHeaders);
  const hoursFirst = hours.rowCount + 1;
  addDropdown(hours, 'A', hoursFirst, TRACKS);
  // Month is text ("Aug-2026") — stop Excel turning it into a date.
  hours.getColumn('D').numFmt = '@';
  dateFormat(hours, 'E', hoursFirst);
  dateFormat(hours, 'F', hoursFirst);
  // Fixed monthly history. DBA for Sep-2026 is deliberately empty: no figure
  // was recorded, and an empty cell is shown blank, not as 0.
  ([
    ['Applications', 40, 'Aug-2026'], ['Infra', 33, 'Aug-2026'], ['DBA', 0, 'Aug-2026'],
    ['Applications', 52, 'Sep-2026'], ['Infra', 10, 'Sep-2026'], ['DBA', null, 'Sep-2026'],
    ['Applications', 0, 'Oct-2026'], ['Infra', 12, 'Oct-2026'], ['DBA', 0, 'Oct-2026'],
  ] as [string, number | null, string][]).forEach(([track, h, month]) => {
    hours.addRow([track, 'Monthly total', h, month]);
  });
  // How a weekly row looks (skipped on import because of the EXAMPLE marker).
  const ex = hours.addRow(['Infra', 'EXAMPLE - Onboarding and Offboarding Changes', 12, '', new Date('2026-11-04'), new Date('2026-11-10')]);
  ex.eachCell((cell) => { cell.font = { italic: true, size: 10, color: { argb: 'FF9AA0AC' } }; });

  // ------------------------------------------------------------ Activities
  const acts = wb.addWorksheet('Activities');
  const actHeaders = ['Workstream', 'Section', 'Detail', 'Sub-bullet of'];
  acts.columns = [{ width: 18 }, { width: 22 }, { width: 86 }, { width: 40 }];
  titleRow(acts, 'Activities Update', actHeaders.length);
  helpRow(acts, 'The written narrative. Each row becomes a bullet. To indent a bullet under another, put the exact text of the parent bullet in "Sub-bullet of". DBA & Infra uses Updates / Recommendations; Fusion SCP and Oracle EBS use Closed / WIP / On-Hold / Others.', actHeaders.length);
  headerRow(acts, actHeaders);
  const actFirst = acts.rowCount + 1;
  addDropdown(acts, 'A', actFirst, WORKSTREAMS);
  addDropdown(acts, 'B', actFirst, ACTIVITY_SECTIONS);
  acts.addRow(['DBA & Infra', 'Updates', 'EXAMPLE - ERPDEV refresh completed as per plan', '']);
  acts.addRow(['DBA & Infra', 'Updates', 'EXAMPLE - EBS workflow', '']);
  acts.addRow(['DBA & Infra', 'Updates', 'EXAMPLE - Currently team is checking the EBS workflow emails every 8 hours once', 'EBS workflow']);
  acts.addRow(['DBA & Infra', 'Recommendations', 'EXAMPLE - Need to disable Partitioning in EBS DB servers as part of the remediation.', '']);
  acts.addRow(['Fusion SCP', 'Closed', 'EXAMPLE - 10916 - FW: load failure', '']);
  acts.addRow(['Fusion SCP', 'WIP', 'EXAMPLE - 7753 - Re: Calendars in Fusion - can we set them?', '']);
  acts.addRow(['Oracle EBS', 'Closed', 'EXAMPLE - Oracle: Truck Loading information reports', '']);
  acts.getColumn(3).alignment = { wrapText: true, vertical: 'top' };

  // --------------------------------------------- Simple list-style sheets
  const simpleSheets: { name: string; title: string; help: string; headers: string[]; widths: number[]; samples: unknown[][] }[] = [
    {
      name: 'Value Additions',
      title: 'Value Additions / Initiatives',
      help: 'Improvements delivered beyond day-to-day ticket work — automation, tuning, documentation, cost savings.',
      headers: ['Title', 'Detail', 'Benefit'],
      widths: [38, 76, 34],
      samples: [['EXAMPLE - Automated invoice reconciliation check', 'Nightly script flags mismatched BAI entries before the finance team sees them.', 'Saves ~3 hours a week']],
    },
    {
      name: 'Project Updates',
      title: 'Projects — Activities Update',
      help: 'Status of ongoing projects. Status uses a dropdown.',
      headers: ['Project', 'Update', 'Status'],
      widths: [34, 80, 18],
      samples: [['EXAMPLE - Magento Integration', 'Catalogue sync tested in staging; awaiting customer sign-off.', 'On Track']],
    },
    {
      name: 'Action Items',
      title: 'Action Items',
      help: 'Open actions with an owner and a due date. Status uses a dropdown.',
      headers: ['Action', 'Owner', 'Due Date', 'Status'],
      widths: [62, 24, 16, 18],
      samples: [['EXAMPLE - Confirm November patch window', 'Russell Winter', new Date('2026-10-15'), 'Open']],
    },
    {
      name: 'Contacts',
      title: 'Contact — leadership shown at the bottom of the report',
      help: 'The people a customer can email with questions. Each row becomes a button in the closing band.',
      headers: ['Name', 'Email', 'Role'],
      widths: [30, 42, 30],
      samples: [['EXAMPLE - Venkatesh B', 'venkatesh.b@doyensys.com', 'Delivery Manager'], ['EXAMPLE - Arunkumar K', 'arunkumar.kubendiran@doyensys.com', 'Support Lead']],
    },
    {
      name: 'Help Needed',
      title: 'Help Needed / Other Updates',
      help: 'Anything blocked on the customer or a third party, and anything else worth raising in the meeting.',
      headers: ['Item', 'Detail', 'Owner'],
      widths: [38, 80, 24],
      samples: [['EXAMPLE - VPN access for new engineer', 'Awaiting customer IT to approve the access request raised on 02-Oct.', 'Petmate IT']],
    },
  ];

  for (const sheet of simpleSheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.widths.map((w) => ({ width: w }));
    titleRow(ws, sheet.title, sheet.headers.length);
    helpRow(ws, sheet.help, sheet.headers.length);
    headerRow(ws, sheet.headers);
    const first = ws.rowCount + 1;
    if (sheet.headers.includes('Status')) {
      const idx = sheet.headers.indexOf('Status');
      const letter = String.fromCharCode(65 + idx);
      addDropdown(ws, letter, first, ['On Track', 'At Risk', 'Delayed', 'Completed', 'Open', 'Closed']);
    }
    if (sheet.headers.includes('Due Date')) {
      const letter = String.fromCharCode(65 + sheet.headers.indexOf('Due Date'));
      dateFormat(ws, letter, first);
    }
    sheet.samples.forEach((smp) => {
      const r = ws.addRow(smp);
      r.font = { italic: true, color: { argb: 'FF9AA0AC' } };
    });
    ws.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
