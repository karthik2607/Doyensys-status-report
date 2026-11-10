import { FastifyInstance } from 'fastify';
import { isSupportRole } from '../lib/tenantContext';
import { buildWeeklyReportTemplate } from '../lib/weeklyReportTemplate';
import { parseWeeklyReportWorkbook } from '../lib/weeklyReportParser';
import { renderWeeklyReportHtml } from '../lib/weeklyReportHtml';
import { makeReportWindow } from '../lib/weeklyReportModel';

// ===========================================================================
// WEEKLY STATUS REPORT — template download and report generation.
//
// Support-only: these produce a document that goes out to a customer, so
// they sit behind the same role check as the rest of the reporting tools.
// Nothing here writes to the database — generating a report is a pure
// transform, and publishing it stays the existing upload-to-a-date flow so
// nothing reaches a customer without someone choosing to put it there.
// ===========================================================================

export async function weeklyReportRoutes(app: FastifyInstance) {
  const supportOnly = {
    preHandler: [app.authenticate, async (req: any, reply: any) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  };

  // GET /api/weekly-report/template?customer=Petmate — the blank .xlsx
  app.get('/api/weekly-report/template', supportOnly, async (req, reply) => {
    const { customer } = req.query as { customer?: string };
    const buf = await buildWeeklyReportTemplate({ customer: customer?.slice(0, 80) });
    const stamp = new Date().toISOString().slice(0, 10);
    const safeCustomer = (customer || 'Customer').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="Doyensys_WeeklyStatusReport_Template_${safeCustomer}_${stamp}.xlsx"`)
      .header('Content-Length', String(buf.length));
    return reply.send(buf);
  });

  // POST /api/weekly-report/generate — multipart .xlsx in, report HTML out.
  app.post('/api/weekly-report/generate', supportOnly, async (req, reply) => {
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'No file was uploaded.' });

    const name = String(file.filename || '');
    if (!/\.(xlsx|xlsm)$/i.test(name)) {
      return reply.code(400).send({ error: 'Upload the filled-in .xlsx template (a .xls or .csv file will not work).' });
    }

    const buffer = await file.toBuffer();
    if (!buffer || buffer.length === 0) return reply.code(400).send({ error: 'The uploaded file is empty.' });

    // The period comes from the generate screen rather than the spreadsheet, so
    // one workbook holding several weeks can produce any of them.
    //
    // Multipart is parsed as a stream, so only the text fields that were sent
    // BEFORE the file part are on `file.fields` by the time we get here. The
    // portal appends startDate and endDate to the FormData first for exactly
    // that reason — moving them after the file would silently lose them.
    const fields = (file as any).fields || {};
    const fieldText = (name: string): string => {
      const f = fields[name];
      const v = Array.isArray(f) ? f[0] : f;
      return typeof v?.value === 'string' ? v.value.trim() : '';
    };
    const rawStart = fieldText('startDate');
    const rawEnd = fieldText('endDate');

    let window = null;
    if (rawStart || rawEnd) {
      const parseIso = (s: string): Date | null => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
        if (!m) return null;
        const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        return Number.isNaN(d.getTime()) ? null : d;
      };
      const start = parseIso(rawStart), end = parseIso(rawEnd);
      if (!start || !end) {
        return reply.code(400).send({ error: 'The start and end dates must both be supplied as yyyy-mm-dd.' });
      }
      const built = makeReportWindow(start, end);
      if ('error' in built) return reply.code(400).send({ error: built.error });
      window = built.window;
    }

    try {
      const data = await parseWeeklyReportWorkbook(buffer, window);
      const html = renderWeeklyReportHtml(data);
      // A short summary travels back with the HTML so the preview can show
      // what was understood before anyone commits to publishing it.
      return reply.send({
        html,
        warnings: data.warnings,
        summary: {
          tickets: data.tickets.length,
          customer: data.info.customer,
          periodStart: data.info.periodStart,
          periodEnd: data.info.periodEnd,
          granularity: data.window?.granularity ?? 'week',
          weeklyCountRows: data.weeklyCounts.length,
          trendWeeks: new Set(data.weeklyCounts.map((c) => c.weekStart.getTime())).size,
          activities: data.activities.length,
          projectHours: data.projectHours.reduce((s, r) => s + (r.hours ?? 0), 0),   // preview count only; empty cells add nothing
          actionItems: data.actionItems.length,
        },
      });
    } catch (err: any) {
      req.log.error({ err }, 'weekly report generation failed');
      return reply.code(400).send({ error: err?.message || 'That workbook could not be read.' });
    }
  });
}
