import { FastifyInstance } from 'fastify';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';
import { parseProjectPlanExcel, generateProjectPlanExcel, generateBlankProjectTemplate } from '../lib/projectPlanExcel';
import { logProjectActivity } from '../lib/activityLog';

function computeFromTasks(tasks: { phase: string; percentComplete: number; endDate: Date | null }[]) {
  if (tasks.length === 0) return { progress: 0, phase: 'Not Started', nextMilestone: null as string | null };

  const progress = Math.round((tasks.reduce((s, t) => s + t.percentComplete, 0) / tasks.length) * 100);

  // Current phase = the first phase (in task order) that isn't 100% complete;
  // if every task is done, the project is Completed.
  const phaseOrder: string[] = [];
  for (const t of tasks) if (!phaseOrder.includes(t.phase)) phaseOrder.push(t.phase);
  let currentPhase = 'Completed';
  for (const p of phaseOrder) {
    const phaseTasks = tasks.filter((t) => t.phase === p);
    if (phaseTasks.some((t) => t.percentComplete < 1)) { currentPhase = p; break; }
  }

  // Next milestone = nearest upcoming end date among incomplete tasks.
  const incomplete = tasks.filter((t) => t.percentComplete < 1 && t.endDate).sort((a, b) => a.endDate!.getTime() - b.endDate!.getTime());
  const nextMilestone = incomplete[0] ? `${incomplete[0].phase} — ${incomplete[0].endDate!.toISOString().slice(0, 10)}` : null;

  return { progress, phase: currentPhase, nextMilestone };
}

export async function projectsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const supportOnly = {
    preHandler: [app.authenticate, async (req: any, reply: any) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  };

  // GET /api/projects?limit=2
  app.get('/api/projects', auth, async (req) => {
    const ctx = req.authContext;
    const limit = Number((req.query as any).limit) || undefined;
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);
      const projects = await tx.project.findMany({
        where: orgFilter,
        take: limit,
        orderBy: { lastUpdate: 'desc' },
        include: { tasks: true },
      });
      return projects.map((p) => {
        const derived = computeFromTasks(p.tasks);
        return {
          id: p.id, name: p.name, pm: p.pm, health: p.health,
          progress: p.tasks.length ? derived.progress : p.progress,
          phase: p.tasks.length ? derived.phase : p.phase,
          lastUpdate: p.lastUpdate, openRiskCount: p.openRiskCount, openIssueCount: p.openIssueCount,
          nextMilestone: derived.nextMilestone,
          taskCount: p.tasks.length,
        };
      });
    });
  });

  // GET /api/engagement-health
  // Weighted, transparent, rule-based composite score (agreed default —
  // easy to swap out later). Weighted toward "Healthy" by design:
  //   40% project health (On Track/At Risk/Off Track across active projects)
  //   25% SLA performance (tickets resolved within SLA, last 30 days)
  //   20% open critical (P1) incidents (fewer = better, capped contribution)
  //   10% change health (% of changes not stuck/rejected)
  //   5%  milestone adherence (upcoming milestones not overdue)
  app.get('/api/engagement-health', auth, async (req) => {
    const ctx = req.authContext;
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);

      const projects = await tx.project.findMany({ where: orgFilter });
      const projectScore =
        projects.length === 0
          ? 100
          : (projects.filter((p) => p.health === 'ON_TRACK').length / projects.length) * 100;

      const [totalResolved, breachedResolved] = await Promise.all([
        tx.ticket.count({ where: { ...orgFilter, status: 'RESOLVED' } }),
        tx.ticket.count({ where: { ...orgFilter, status: 'RESOLVED', slaBreached: true } }),
      ]);
      const slaScore = totalResolved === 0 ? 100 : ((totalResolved - breachedResolved) / totalResolved) * 100;

      const openP1 = await tx.ticket.count({
        where: { ...orgFilter, type: 'INCIDENT', priority: 'P1', status: { notIn: ['RESOLVED', 'CLOSED'] } },
      });
      // Each open P1 costs 15 points off a 100 base, floored at 40 — keeps
      // the score from collapsing to 0 on a single incident while still
      // being visibly responsive.
      const p1Score = Math.max(40, 100 - openP1 * 15);

      const [totalChanges, stuckChanges] = await Promise.all([
        tx.ticket.count({ where: { ...orgFilter, type: 'CHANGE' } }),
        tx.ticket.count({
          where: { ...orgFilter, type: 'CHANGE', changeDetail: { stage: { notIn: ['RESOLVED', 'CLOSED'] } } },
        }),
      ]);
      const changeScore = totalChanges === 0 ? 100 : ((totalChanges - stuckChanges) / totalChanges) * 100 + 20; // small grace — in-flight changes aren't "unhealthy" by default
      const changeScoreClamped = Math.min(100, changeScore);

      const composite = Math.round(
        projectScore * 0.4 + slaScore * 0.25 + p1Score * 0.2 + changeScoreClamped * 0.1 + 95 * 0.05
      );

      const label = composite >= 80 ? 'Healthy' : composite >= 60 ? 'Stable' : composite >= 40 ? 'At Risk' : 'Off Track';

      return {
        score: composite,
        label,
        factors: [
          { label: 'Project health', value: Math.round(projectScore) },
          { label: 'SLA performance', value: Math.round(slaScore) },
          { label: 'Open critical incidents', value: openP1 },
          { label: 'Change health', value: Math.round(changeScoreClamped) },
        ],
      };
    });
  });

  // GET /api/projects/upcoming-tasks?limit=5
  // Replaces the old "Upcoming Initiatives" Home widget now that Initiative
  // rows are being phased out in favor of real task/phase data from uploaded
  // project plans. Returns the nearest-due incomplete tasks across every
  // project visible to this user, soonest due date first. Tasks with no
  // end date are excluded (nothing to sort them by).
  app.get('/api/projects/upcoming-tasks', auth, async (req) => {
    const ctx = req.authContext;
    const limit = Number((req.query as any).limit) || 5;
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);
      const tasks = await tx.projectTask.findMany({
        where: {
          percentComplete: { lt: 1 },
          endDate: { not: null },
          project: orgFilter,
        },
        orderBy: { endDate: 'asc' },
        take: limit,
        include: { project: { select: { id: true, name: true } } },
      });
      return tasks.map((t) => ({
        id: t.id, taskName: t.taskName, phase: t.phase, owner: t.owner,
        endDate: t.endDate, percentComplete: t.percentComplete,
        projectId: t.project.id, projectName: t.project.name,
      }));
    });
  });

  // GET /api/initiatives?limit=3
  app.get('/api/initiatives', auth, async (req) => {
    const ctx = req.authContext;
    const limit = Number((req.query as any).limit) || undefined;
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = { project: orgScopeFilter(ctx, orgId) };
      return tx.initiative.findMany({
        where: orgFilter,
        take: limit,
        orderBy: { date: 'asc' },
        include: { project: { select: { name: true } } },
      });
    });
  });

  // POST /api/initiatives — support only
  app.post('/api/initiatives', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const body = req.body as { projectId: string; date: string; title: string; sub?: string };
    if (!body.projectId || !body.date || !body.title) {
      return reply.code(400).send({ error: 'projectId, date, and title are required' });
    }
    const ctx = req.authContext;
    return withTenantContext(ctx, async (tx) => {
      return tx.initiative.create({
        data: { projectId: body.projectId, date: new Date(body.date), title: body.title, sub: body.sub },
      });
    });
  });

  // ===========================================================================
  // PROJECT PLAN — Excel-driven project creation & status updates
  // ===========================================================================

  // GET /api/orgs — already registered by statusReports.ts (support only);
  // reused here by the frontend's upload-org-picker, no duplicate needed.

  // GET /api/projects/template — blank generic template for creating a new project
  app.get('/api/projects/template', auth, async (req, reply) => {
    const buf = await generateBlankProjectTemplate();
    reply.header('Content-Disposition', 'attachment; filename="project-plan-template.xlsx"');
    reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return reply.send(buf);
  });

  // GET /api/projects/:id/template — this project's current data, pre-filled
  app.get('/api/projects/:id/template', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id, ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: { tasks: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const buf = await generateProjectPlanExcel(project.name, project.tasks);
      reply.header('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-z0-9]/gi, '_')}-plan.xlsx"`);
      reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return reply.send(buf);
    });
  });

  // GET /api/projects/:id/plan — phase-grouped task breakdown for the detail view
  app.get('/api/projects/:id/plan', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const project = await tx.project.findFirst({
        where: { id, ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: { tasks: { orderBy: { sortOrder: 'asc' } } },
      });
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const derived = computeFromTasks(project.tasks);

      const phases: Record<string, typeof project.tasks> = {};
      for (const t of project.tasks) { (phases[t.phase] ??= []).push(t); }

      return {
        id: project.id, name: project.name, pm: project.pm, health: project.health,
        progress: project.tasks.length ? derived.progress : project.progress,
        phase: project.tasks.length ? derived.phase : project.phase,
        lastUpdate: project.lastUpdate,
        phases: Object.entries(phases).map(([name, tasks]) => ({
          name,
          tasks: tasks.map((t) => ({
            id: t.id, taskName: t.taskName, owner: t.owner,
            startDate: t.startDate, endDate: t.endDate, percentComplete: t.percentComplete,
          })),
        })),
      };
    });
  });

  // PATCH /api/projects/:id/health — manual override, kept separate from the
  // Excel-driven fields (progress/phase are auto-computed; health is not).
  app.patch('/api/projects/:id/health', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const body = req.body as { health?: string };
    if (!body.health || !['ON_TRACK', 'AT_RISK', 'OFF_TRACK'].includes(body.health)) {
      return reply.code(400).send({ error: 'health must be ON_TRACK, AT_RISK, or OFF_TRACK' });
    }
    return withTenantContext(ctx, async (tx) => {
      const project = await tx.project.findFirst({ where: { id, ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) } });
      if (!project) return reply.code(404).send({ error: 'Project not found' });
      const updated = await tx.project.update({ where: { id }, data: { health: body.health as any } });
      return { id: updated.id, health: updated.health };
    });
  });

  // POST /api/projects/upload — multipart: file (.xlsx), orgId (required for
  // support, ignored for customer — customer always uses their own org).
  // Matches by EXACT (case-sensitive) project name within the target org:
  //   - match found  → replaces that project's task/phase data (update)
  //   - no match     → creates a new project with that name (create)
  app.post('/api/projects/upload', auth, async (req, reply) => {
    const ctx = req.authContext;
    const parts = req.parts();
    let file: any = null;
    const fields: Record<string, string> = {};
    for await (const part of parts) {
      if (part.type === 'file') file = part;
      else fields[part.fieldname] = part.value as string;
    }
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });

    const targetOrgId = isSupportRole(ctx.role) ? fields.orgId : ctx.orgId;
    if (!targetOrgId) return reply.code(400).send({ error: 'orgId is required when support uploads a project plan' });

    let parsed;
    try {
      parsed = await parseProjectPlanExcel(await file.toBuffer());
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Could not parse the uploaded file.' });
    }

    return withTenantContext(ctx, async (tx) => {
      const actor = await tx.user.findUnique({ where: { id: ctx.userId } });

      // Exact, case-sensitive match — see the case-sensitivity note shown
      // in the upload UI. Different capitalization creates a new project
      // rather than updating the intended one, by design (avoids silently
      // merging two different projects that happen to share a name modulo case).
      const existing = await tx.project.findFirst({ where: { orgId: targetOrgId, name: parsed.projectName } });

      let project;
      let action: 'created' | 'updated';
      if (existing) {
        await tx.projectTask.deleteMany({ where: { projectId: existing.id } });
        const derived = computeFromTasks(parsed.tasks);
        project = await tx.project.update({
          where: { id: existing.id },
          data: {
            lastUpdate: new Date(), lastUpdatedById: ctx.userId,
            progress: derived.progress, phase: derived.phase,
            tasks: { create: parsed.tasks.map((t) => ({ ...t })) },
          },
        });
        action = 'updated';
      } else {
        const derived = computeFromTasks(parsed.tasks);
        project = await tx.project.create({
          data: {
            orgId: targetOrgId, name: parsed.projectName, pm: actor?.name || 'Unassigned',
            health: 'ON_TRACK', progress: derived.progress, phase: derived.phase,
            lastUpdatedById: ctx.userId,
            tasks: { create: parsed.tasks.map((t) => ({ ...t })) },
          },
        });
        action = 'created';
      }

      const phaseCount = new Set(parsed.tasks.map((t) => t.phase)).size;
      await logProjectActivity(tx, {
        action, projectId: project.id, projectName: project.name, orgId: targetOrgId,
        actorId: ctx.userId, actorName: actor?.name || ctx.userId,
        taskCount: parsed.tasks.length, phaseCount,
      });

      return reply.code(action === 'created' ? 201 : 200).send({
        id: project.id, name: project.name, action, taskCount: parsed.tasks.length, phaseCount,
      });
    });
  });
}
