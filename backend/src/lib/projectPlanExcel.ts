import ExcelJS from 'exceljs';

export interface ParsedTask {
  phase: string;
  taskName: string;
  owner: string;
  startDate: Date | null;
  endDate: Date | null;
  percentComplete: number; // 0..1
  sortOrder: number;
}

export interface ParsedPlan {
  projectName: string;
  tasks: ParsedTask[];
}

const HEADER_ALIASES: Record<string, string[]> = {
  sl: ['sl'],
  phase: ['phase'],
  taskName: ['tasks', 'task'],
  owner: ['owner'],
  startDate: ['start date'],
  endDate: ['end date'],
  percentComplete: ['percentage of completion', 'percent complete', '% complete'],
};

function normalizeHeader(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  const parsed = new Date(String(v));
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** Parses an uploaded project-plan .xlsx buffer into a project name and its
 * phase-grouped task list. Throws a descriptive Error if the file doesn't
 * look like the expected template, so the route can surface a clear 400. */
export async function parseProjectPlanExcel(buffer: Buffer): Promise<ParsedPlan> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('The uploaded file has no worksheets.');

  // Find the "Project name" label anywhere in the first few rows, and take
  // the cell immediately to its right as the value.
  let projectName: string | null = null;
  for (let r = 1; r <= 5 && !projectName; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (normalizeHeader(row.getCell(c).value) === 'project name') {
        const raw = row.getCell(c + 1).value;
        projectName = String(raw ?? '').trim();
        break;
      }
    }
  }
  if (!projectName) throw new Error('Could not find a "Project name" cell in the file — is this the right template?');

  // Find the header row (contains "Tasks") within the first 6 rows, then map
  // each expected column to whichever spreadsheet column actually has it.
  let headerRowIdx = -1;
  const colMap: Record<string, number> = {};
  for (let r = 1; r <= 6 && headerRowIdx === -1; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (normalizeHeader(row.getCell(c).value) === 'tasks') {
        headerRowIdx = r;
        for (let cc = 1; cc <= row.cellCount; cc++) {
          const h = normalizeHeader(row.getCell(cc).value);
          for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
            if (aliases.includes(h)) colMap[field] = cc;
          }
        }
        break;
      }
    }
  }
  if (headerRowIdx === -1 || !colMap.taskName) {
    throw new Error('Could not find the task table headers (expected a "Tasks" column) — is this the right template?');
  }

  const tasks: ParsedTask[] = [];
  let currentPhase = '';
  let sortOrder = 0;

  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const taskName = String(row.getCell(colMap.taskName).value ?? '').trim();
    if (!taskName) continue; // blank row — skip (don't stop, in case of a stray gap)

    const phaseCell = colMap.phase ? String(row.getCell(colMap.phase).value ?? '').trim() : '';
    if (phaseCell) currentPhase = phaseCell; // forward-fill, per the template's convention

    let pct = colMap.percentComplete ? Number(row.getCell(colMap.percentComplete).value ?? 0) : 0;
    if (isNaN(pct)) pct = 0;
    if (pct > 1) pct = pct / 100; // tolerate someone entering 50 instead of 0.5
    pct = Math.min(1, Math.max(0, pct));

    tasks.push({
      phase: currentPhase || 'Unspecified Phase',
      taskName,
      owner: colMap.owner ? String(row.getCell(colMap.owner).value ?? '').trim() : '',
      startDate: colMap.startDate ? toDate(row.getCell(colMap.startDate).value) : null,
      endDate: colMap.endDate ? toDate(row.getCell(colMap.endDate).value) : null,
      percentComplete: pct,
      sortOrder: sortOrder++,
    });
  }

  if (tasks.length === 0) throw new Error('No task rows found under the header row.');

  return { projectName, tasks };
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B1F27' } };
const HEADER_FONT: Partial<ExcelJS.Font> = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
const BODY_FONT: Partial<ExcelJS.Font> = { name: 'Arial', size: 10 };

function buildSheet(sheet: ExcelJS.Worksheet, projectName: string, tasks: ParsedTask[]) {
  sheet.getCell('B1').value = 'Project name';
  sheet.getCell('B1').font = { ...BODY_FONT, bold: true };
  sheet.getCell('C1').value = projectName;
  sheet.getCell('C1').font = BODY_FONT;

  const headers = ['SL', 'Phase', 'Tasks', 'owner', 'Start Date', 'End Date', 'Percentage of Completion'];
  const headerRow = sheet.getRow(2);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = HEADER_FONT;
    cell.fill = HEADER_FILL;
  });

  let sl = 1;
  let lastPhase: string | null = null;
  let r = 3;
  for (const t of tasks) {
    const row = sheet.getRow(r);
    const isNewPhase = t.phase !== lastPhase;
    row.getCell(1).value = isNewPhase ? sl++ : null;
    row.getCell(2).value = isNewPhase ? t.phase : null;
    row.getCell(3).value = t.taskName;
    row.getCell(4).value = t.owner;
    row.getCell(5).value = t.startDate;
    row.getCell(6).value = t.endDate;
    row.getCell(7).value = t.percentComplete;
    row.getCell(5).numFmt = 'yyyy-mm-dd';
    row.getCell(6).numFmt = 'yyyy-mm-dd';
    row.getCell(7).numFmt = '0%';
    for (let c = 1; c <= 7; c++) row.getCell(c).font = BODY_FONT;
    lastPhase = t.phase;
    r++;
  }

  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 18;
  sheet.getColumn(3).width = 32;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 14;
  sheet.getColumn(6).width = 14;
  sheet.getColumn(7).width = 22;
}

/** Generates a filled-in template for an existing project's current data —
 * used by the "Download Template" button so it's easy to edit and re-upload. */
export async function generateProjectPlanExcel(projectName: string, tasks: ParsedTask[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  buildSheet(sheet, projectName, tasks);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Generates the blank generic template for creating a brand-new project —
 * includes one example phase with two example tasks, per convention for a
 * fill-in workbook (a legend of what goes where, not real data). */
export async function generateBlankProjectTemplate(): Promise<Buffer> {
  const exampleTasks: ParsedTask[] = [
    { phase: 'Dev Phase', taskName: 'Example task — replace with your own', owner: 'Doyensys', startDate: new Date(), endDate: new Date(), percentComplete: 0, sortOrder: 0 },
    { phase: 'Dev Phase', taskName: 'Another example task', owner: 'Customer', startDate: new Date(), endDate: new Date(), percentComplete: 0, sortOrder: 1 },
  ];
  return generateProjectPlanExcel('Enter Project Name Here', exampleTasks);
}
