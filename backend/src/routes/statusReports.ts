import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantContext, isSupportRole } from '../lib/tenantContext';
import { notifyAndEmail } from '../lib/notify';

const HEALTH_TO_DISPLAY: Record<string, string> = {
  ON_TRACK: 'On Track', STABLE: 'Stable', GOOD: 'Good', AT_RISK: 'At Risk', OFF_TRACK: 'Off Track',
};
const HEALTH_TO_API: Record<string, string> = Object.fromEntries(Object.entries(HEALTH_TO_DISPLAY).map(([k, v]) => [v, k]));

function dateKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

function serializeReport(r: any) {
  const bySection = (section: string) =>
    r.listItems.filter((i: any) => i.section === section).sort((a: any, b: any) => a.sortOrder - b.sortOrder).map((i: any) => i.text);

  return {
    id: r.id, type: r.type.charAt(0) + r.type.slice(1).toLowerCase(), period: r.period,
    project: r.project.name, author: r.author.name, published: r.publishedAt ? dateKey(r.publishedAt) : null,
    isPublished: r.isPublished,
    summary: r.summary,
    health: {
      overall: HEALTH_TO_DISPLAY[r.healthOverall], schedule: HEALTH_TO_DISPLAY[r.healthSchedule],
      budget: HEALTH_TO_DISPLAY[r.healthBudget], scope: HEALTH_TO_DISPLAY[r.healthScope], quality: HEALTH_TO_DISPLAY[r.healthQuality],
    },
    completed: bySection('COMPLETED'), inProgress: bySection('IN_PROGRESS'), planned: bySection('PLANNED'),
    upcoming: bySection('UPCOMING'), customerActions: bySection('CUSTOMER_ACTIONS'),
    risks: r.risks.map((x: any) => ({ desc: x.description, impact: x.impact, probability: x.probability, mitigation: x.mitigation, owner: x.owner })),
    issues: r.issues.map((x: any) => ({ issue: x.issue, impact: x.impact, resolution: x.resolution, owner: x.owner, target: x.targetDate })),
    milestones: r.milestones.map((x: any) => ({ date: dateKey(x.date), label: x.label })),
    itsm: { openIncidents: r.itsmOpenIncidents, openRequests: r.itsmOpenRequests, changes: r.itsmChanges, slaPerf: r.itsmSlaPerf },
  };
}

export async function statusReportsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const supportOnly = {
    preHandler: [app.authenticate, async (req: any, reply: any) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  };

  const include = {
    project: { select: { name: true } }, author: { select: { name: true } },
    listItems: true, risks: true, issues: true, milestones: true,
  };

  // GET /api/status-reports — returns { daily: {date: report}, weekly: {...}, monthly: {...} }
  // Customers see published only; support sees drafts too (for Manage Reports).
  app.get('/api/status-reports', auth, async (req) => {
    const ctx = req.authContext;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId };
      const publishedFilter = isSupportRole(ctx.role) ? {} : { isPublished: true };
      const reports = await tx.statusReport.findMany({ where: { ...orgFilter, ...publishedFilter }, include });

      const bucket: Record<string, Record<string, any>> = { daily: {}, weekly: {}, monthly: {} };
      for (const r of reports) {
        const typeKey = r.type.toLowerCase();
        const key = dateKey(r.periodEnd);
        bucket[typeKey][key] = serializeReport(r);
      }
      return bucket;
    });
  });

  const createSchema = z.object({
    projectId: z.string().min(1), type: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    period: z.string().min(1), periodStart: z.string(), periodEnd: z.string(), summary: z.string().min(1),
    health: z.object({ overall: z.string(), schedule: z.string(), budget: z.string(), scope: z.string(), quality: z.string() }),
    completed: z.array(z.string()).default([]), inProgress: z.array(z.string()).default([]), planned: z.array(z.string()).default([]),
    upcoming: z.array(z.string()).default([]), customerActions: z.array(z.string()).default([]),
    risks: z.array(z.object({ desc: z.string(), impact: z.string(), probability: z.string(), mitigation: z.string(), owner: z.string() })).default([]),
    issues: z.array(z.object({ issue: z.string(), impact: z.string(), resolution: z.string(), owner: z.string(), target: z.string() })).default([]),
    milestones: z.array(z.object({ date: z.string(), label: z.string() })).default([]),
    itsm: z.object({ openIncidents: z.number(), openRequests: z.number(), changes: z.number(), slaPerf: z.string() }),
  });

  // POST /api/status-reports — support only, creates a draft (unpublished)
  app.post('/api/status-reports', supportOnly, async (req, reply) => {
    const ctx = req.authContext;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Missing or invalid report fields', details: parsed.error.flatten() });
    const d = parsed.data;

    return withTenantContext(ctx, async (tx) => {
      const project = await tx.project.findUnique({ where: { id: d.projectId } });
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const report = await tx.statusReport.create({
        data: {
          orgId: project.orgId, projectId: d.projectId, type: d.type, period: d.period,
          periodStart: new Date(d.periodStart), periodEnd: new Date(d.periodEnd), authorId: ctx.userId, summary: d.summary,
          healthOverall: HEALTH_TO_API[d.health.overall] as any, healthSchedule: HEALTH_TO_API[d.health.schedule] as any,
          healthBudget: HEALTH_TO_API[d.health.budget] as any, healthScope: HEALTH_TO_API[d.health.scope] as any,
          healthQuality: HEALTH_TO_API[d.health.quality] as any,
          itsmOpenIncidents: d.itsm.openIncidents, itsmOpenRequests: d.itsm.openRequests,
          itsmChanges: d.itsm.changes, itsmSlaPerf: d.itsm.slaPerf,
          listItems: {
            create: [
              ...d.completed.map((text, i) => ({ section: 'COMPLETED' as const, text, sortOrder: i })),
              ...d.inProgress.map((text, i) => ({ section: 'IN_PROGRESS' as const, text, sortOrder: i })),
              ...d.planned.map((text, i) => ({ section: 'PLANNED' as const, text, sortOrder: i })),
              ...d.upcoming.map((text, i) => ({ section: 'UPCOMING' as const, text, sortOrder: i })),
              ...d.customerActions.map((text, i) => ({ section: 'CUSTOMER_ACTIONS' as const, text, sortOrder: i })),
            ],
          },
          risks: { create: d.risks.map((r) => ({ description: r.desc, impact: r.impact, probability: r.probability, mitigation: r.mitigation, owner: r.owner })) },
          issues: { create: d.issues.map((i) => ({ issue: i.issue, impact: i.impact, resolution: i.resolution, owner: i.owner, targetDate: i.target })) },
          milestones: { create: d.milestones.map((m) => ({ date: new Date(m.date), label: m.label })) },
        },
      });
      return reply.code(201).send({ id: report.id });
    });
  });

  // POST /api/status-reports/:id/publish
  app.post('/api/status-reports/:id/publish', supportOnly, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const report = await tx.statusReport.update({ where: { id }, data: { isPublished: true, publishedAt: new Date() } });
      // Notify every customer user in that org that a new report is available.
      const users = await tx.user.findMany({ where: { orgId: report.orgId, role: { in: ['CUSTOMER_ADMIN', 'CUSTOMER_VIEWER'] } } });
      for (const u of users) {
        await notifyAndEmail(tx, {
          orgId: report.orgId, userId: u.id, title: 'New status report published',
          sub: report.period, category: 'REPORT', refType: 'status_report', refId: report.id,
        });
      }
      return { id: report.id, isPublished: true };
    });
  });

  // POST /api/status-reports/:id/unpublish
  app.post('/api/status-reports/:id/unpublish', supportOnly, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const report = await tx.statusReport.update({ where: { id }, data: { isPublished: false } });
      return { id: report.id, isPublished: false };
    });
  });

  // ===========================================================================
  // FILE-BASED REPORTS — support uploads a complete HTML report for a given
  // calendar date; customers view it rendered in an iframe.
  // ===========================================================================
  const uploadsDir = () => `${process.env.ATTACHMENTS_DIR ?? '/opt/doyensys/uploads'}/status-reports`;

  // GET /api/status-report-files?type=WEEKLY&month=2026-09&orgId=...
  // orgId is required for support (they must choose which customer they're
  // looking at); ignored for customers, who are always scoped to their own org.
  app.get('/api/status-report-files', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as any;
    const type = (q.type || 'WEEKLY').toUpperCase();
    return withTenantContext(ctx, async (tx) => {
      const orgId = isSupportRole(ctx.role) ? (q.orgId || ctx.orgId) : ctx.orgId;
      const uploads = await tx.statusReportUpload.findMany({
        where: { orgId, type },
        include: { uploadedBy: { select: { name: true } } },
        orderBy: { reportDate: 'desc' },
      });
      return uploads.map((u) => ({
        id: u.id, date: dateKey(u.reportDate), filename: u.filename,
        uploadedBy: u.uploadedBy.name, uploadedAt: u.createdAt,
      }));
    });
  });

  // GET /api/orgs — support only. Powers the org-picker on the status
  // report upload form AND the workspace picker (support choosing which
  // customer's tenant to work in).
  app.get('/api/orgs', supportOnly, async () => {
    const { prisma } = await import('../lib/prisma');
    const orgs = await prisma.org.findMany({
      where: { type: 'CUSTOMER' },
      orderBy: { name: 'asc' },
      include: { settings: { select: { logoUrl: true } } },
    });
    return orgs.map((o) => ({ id: o.id, name: o.name, logoUrl: o.settings?.logoUrl ?? null }));
  });

  // POST /api/status-report-files — support only, multipart upload.
  // Fields: file (the HTML), type, reportDate (YYYY-MM-DD), orgId
  // Upserts on (orgId, type, reportDate) — re-uploading for the same date
  // replaces what was there.
  app.post('/api/status-report-files', supportOnly, async (req, reply) => {
    const ctx = req.authContext;
    const parts = req.parts();
    let file: any = null;
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === 'file') file = part;
      else fields[part.fieldname] = part.value as string;
    }
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });
    if (!fields.reportDate || !fields.orgId) return reply.code(400).send({ error: 'reportDate and orgId are required' });
    const type = (fields.type || 'WEEKLY').toUpperCase();

    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });

    const buffer = await file.toBuffer();
    const storedName = `${fields.orgId}-${type}-${fields.reportDate}-${Date.now()}.html`;
    const storedPath = path.join(dir, storedName);
    fs.writeFileSync(storedPath, buffer);

    return withTenantContext(ctx, async (tx) => {
      const upload = await tx.statusReportUpload.upsert({
        where: { orgId_type_reportDate: { orgId: fields.orgId, type: type as any, reportDate: new Date(fields.reportDate) } },
        update: { filename: file.filename, storedPath, mimeType: 'text/html', sizeBytes: buffer.length, uploadedById: ctx.userId },
        create: {
          orgId: fields.orgId, type: type as any, reportDate: new Date(fields.reportDate),
          uploadedById: ctx.userId, filename: file.filename, storedPath, mimeType: 'text/html', sizeBytes: buffer.length,
        },
      });

      const users = await tx.user.findMany({ where: { orgId: fields.orgId, role: { in: ['CUSTOMER_ADMIN', 'CUSTOMER_VIEWER'] } } });
      for (const u of users) {
        await notifyAndEmail(tx, {
          orgId: fields.orgId, userId: u.id, title: 'New status report published',
          sub: `Report for ${fields.reportDate}`, category: 'REPORT', refType: 'status_report_upload', refId: upload.id,
        });
      }

      return reply.code(201).send({ id: upload.id, date: dateKey(upload.reportDate) });
    });
  });

  // GET /api/status-report-files/:id/content — returns the raw HTML text
  // (not JSON) so the frontend can render it in a sandboxed iframe via a
  // blob URL. Auth still required.
  app.get('/api/status-report-files/:id/content', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const upload = await tx.statusReportUpload.findFirst({
        where: { id, ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
      });
      if (!upload) return reply.code(404).send({ error: 'Report not found' });
      const fs = await import('node:fs');
      if (!fs.existsSync(upload.storedPath)) return reply.code(404).send({ error: 'Report file missing on disk' });
      const html = fs.readFileSync(upload.storedPath, 'utf-8');
      reply.type('text/html');
      return reply.send(html);
    });
  });

  // DELETE /api/status-report-files/:id — support only, removes the DB row
  // and the file on disk.
  app.delete('/api/status-report-files/:id', supportOnly, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const upload = await tx.statusReportUpload.findUnique({ where: { id } });
      if (!upload) return reply.code(404).send({ error: 'Report not found' });

      await tx.statusReportUpload.delete({ where: { id } });

      const fs = await import('node:fs');
      try { if (fs.existsSync(upload.storedPath)) fs.unlinkSync(upload.storedPath); }
      catch (err) { console.error('Failed to delete report file from disk:', err); }

      return { id, deleted: true };
    });
  });
}
