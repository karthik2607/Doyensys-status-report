import { FastifyInstance } from 'fastify';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';
import { prisma } from '../lib/prisma';

export async function dashboardRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  // GET /api/dashboard/summary — welcome banner
  app.get('/api/dashboard/summary', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as { orgId?: string };
    return withTenantContext(ctx, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: ctx.userId },
        include: { org: true },
      });
      // The greeting is always the logged-in person's own name. The
      // "Organization" shown alongside it reflects the workspace support
      // has currently entered (see orgScopeFilter) rather than their own
      // (Doyensys) org, so the banner is meaningful once they're inside a
      // specific customer's tenant.
      let orgName = user!.org.name;
      if (isSupportRole(ctx.role) && q.orgId) {
        const workspaceOrg = await tx.org.findUnique({ where: { id: q.orgId } });
        if (workspaceOrg) orgName = workspaceOrg.name;
      }
      return {
        name: user!.name,
        org: orgName,
        lastActivity: user!.lastLoginAt,
        // Engagement health is org-level; support users viewing without a
        // specific org context get a neutral placeholder for now.
        engagementHealth: 'Healthy',
      };
    });
  });

  // GET /api/dashboard/stats — the 4 KPI stat cards
  app.get('/api/dashboard/stats', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as { orgId?: string };
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, q.orgId);

      const [activeProjects, openIncidents, openRequests, pendingChanges] = await Promise.all([
        tx.project.count({ where: orgFilter }),
        tx.ticket.count({ where: { ...orgFilter, type: 'INCIDENT', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
        tx.ticket.count({ where: { ...orgFilter, type: 'REQUEST', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
        tx.ticket.count({
          where: {
            ...orgFilter,
            type: 'CHANGE',
            changeDetail: { stage: { in: ['CUSTOMER_APPROVAL', 'DEV_REVIEW', 'TEST_REVIEW'] } },
          },
        }),
      ]);

      return {
        engagementHealth: 'Healthy',
        activeProjects,
        openTickets: openIncidents + openRequests,
        pendingApprovals: pendingChanges,
      };
    });
  });

  // GET /api/dashboard/counts — left-nav badges
  app.get('/api/dashboard/counts', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as { orgId?: string };
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, q.orgId);

      const [openIncidents, openRequests, openChanges, unreadNotifications] = await Promise.all([
        tx.ticket.count({ where: { ...orgFilter, type: 'INCIDENT', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
        tx.ticket.count({ where: { ...orgFilter, type: 'REQUEST', status: { notIn: ['RESOLVED', 'CLOSED'] } } }),
        tx.ticket.count({
          where: { ...orgFilter, type: 'CHANGE', changeDetail: { stage: { not: 'CLOSED' } } },
        }),
        tx.notification.count({ where: { userId: ctx.userId, isRead: false } }),
      ]);

      return { openIncidents, openRequests, openChanges, unreadNotifications };
    });
  });

  // GET /api/dashboard/activity-since-last-visit
  app.get('/api/dashboard/activity-since-last-visit', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as { orgId?: string };
    return withTenantContext(ctx, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: ctx.userId } });
      const since = user?.lastLoginAt ?? new Date(0);
      const orgFilter = orgScopeFilter(ctx, q.orgId);

      const [resolvedTickets, publishedReports] = await Promise.all([
        tx.ticket.findMany({
          where: { ...orgFilter, status: 'RESOLVED', updatedAt: { gte: since } },
          select: { id: true, title: true, type: true, updatedAt: true },
          take: 5,
          orderBy: { updatedAt: 'desc' },
        }),
        tx.statusReport.findMany({
          where: { ...orgFilter, isPublished: true, publishedAt: { gte: since } },
          select: { id: true, project: { select: { name: true } }, period: true, publishedAt: true },
          take: 5,
          orderBy: { publishedAt: 'desc' },
        }),
      ]);

      const items = [
        ...resolvedTickets.map((t) => ({
          type: 'ticket_resolved',
          title: `${t.id.slice(0, 8)} resolved`,
          sub: t.title,
          occurredAt: t.updatedAt,
        })),
        ...publishedReports.map((r) => ({
          type: 'report_published',
          title: 'Status report published',
          sub: `${r.project.name} — ${r.period}`,
          occurredAt: r.publishedAt,
        })),
      ].sort((a, b) => (b.occurredAt?.getTime() ?? 0) - (a.occurredAt?.getTime() ?? 0));

      return items;
    });
  });

  // GET /api/dashboard/action-items — role-filtered "needs your attention" queue
  app.get('/api/dashboard/action-items', auth, async (req) => {
    const ctx = req.authContext;
    const q = req.query as { orgId?: string };
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, q.orgId);
      const items: Array<{
        type: string; refId: string; title: string; sub: string;
        priority: string; actionLabel: string;
      }> = [];

      if (!isSupportRole(ctx.role)) {
        const pendingChanges = await tx.ticket.findMany({
          where: {
            ...orgFilter,
            type: 'CHANGE',
            changeDetail: { stage: { in: ['CUSTOMER_APPROVAL', 'DEV_REVIEW', 'TEST_REVIEW'] } },
          },
          include: { changeDetail: true },
        });
        for (const c of pendingChanges) {
          const stage = c.changeDetail!.stage;
          const labels: Record<string, string> = {
            CUSTOMER_APPROVAL: 'Review Change',
            DEV_REVIEW: 'Review Development',
            TEST_REVIEW: 'Review Test Results',
          };
          items.push({
            type: 'change', refId: c.id,
            title: `Change ${c.id.slice(0, 8)} needs your review`,
            sub: c.title, priority: c.priority, actionLabel: labels[stage] ?? 'Review',
          });
        }
      }

      const waitingIncidents = await tx.ticket.findMany({
        where: { ...orgFilter, type: 'INCIDENT', status: 'WAITING_ON_CUSTOMER' },
      });
      for (const i of waitingIncidents) {
        items.push({
          type: 'incident', refId: i.id,
          title: `${i.id.slice(0, 8)} awaiting customer information`,
          sub: i.title, priority: i.priority, actionLabel: 'Provide Information',
        });
      }

      if (isSupportRole(ctx.role)) {
        const openIncidents = await tx.ticket.findMany({
          where: { ...orgFilter, type: 'INCIDENT', status: { notIn: ['RESOLVED', 'CLOSED'] } },
          take: 10,
        });
        for (const i of openIncidents) {
          items.push({
            type: 'incident', refId: i.id,
            title: `${i.id.slice(0, 8)} needs a response`,
            sub: i.title, priority: i.priority, actionLabel: 'Open Ticket',
          });
        }
      }

      return items;
    });
  });

  // GET /api/company-updates
  app.get('/api/company-updates', auth, async () => {
    // Not tenant-scoped — visible to everyone, same as the prototype.
    return prisma.companyUpdate.findMany({ orderBy: { date: 'desc' }, take: 10 });
  });
}
