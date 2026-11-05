import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';
import { notifyAndEmail, notifyAllSupport } from '../lib/notify';
import { ticketEmailDetail } from '../lib/ticketEmail';

const STATUS_ORDER = ['RAISED', 'RESPONDED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;

/** Human-readable ticket code — INC000101 style, from the sequential
 * `number` column, not derived from the UUID. */
function incidentCode(number: number) { return `INC${String(number).padStart(6, '0')}`; }

function slaPct(dueAt: Date | null, createdAt: Date): number | null {
  if (!dueAt) return null;
  const total = dueAt.getTime() - createdAt.getTime();
  const elapsed = Date.now() - createdAt.getTime();
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

export async function incidentsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  // GET /api/incidents  (?mine=true to scope to the caller's own tickets)
  app.get('/api/incidents', auth, async (req) => {
    const ctx = req.authContext;
    const mine = (req.query as any).mine === 'true';
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);
      const mineFilter = mine ? { requestorId: ctx.userId } : {};
      const tickets = await tx.ticket.findMany({
        where: { ...orgFilter, ...mineFilter, type: 'INCIDENT' },
        include: { requestor: { select: { name: true } }, assignee: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return tickets.map((t) => ({
        id: t.id, code: incidentCode(t.number), title: t.title, priority: t.priority, status: t.status,
        requestor: t.requestor.name, assignee: t.assignee?.name ?? 'Unassigned', assigneeId: t.assigneeId,
        created: t.createdAt,
        slaPct: slaPct(t.resolutionSlaDueAt, t.createdAt),
      }));
    });
  });

  // GET /api/incidents/:id
  app.get('/api/incidents/:id', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, type: 'INCIDENT', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: {
          requestor: { select: { id: true, name: true } },
          assignee: { select: { id: true, name: true } },
          notes: {
            // Belt-and-suspenders: filtered here even though RLS already
            // enforces this — see the internal note security design.
            where: isSupportRole(ctx.role) ? {} : { visibility: 'CUSTOMER' },
            include: { author: { select: { name: true, role: true } } },
            orderBy: { createdAt: 'asc' },
          },
          events: { orderBy: { createdAt: 'asc' } },
          attachments: true,
        },
      });
      if (!ticket) return reply.code(404).send({ error: 'Incident not found' });

      return {
        id: ticket.id, code: incidentCode(ticket.number), title: ticket.title, description: ticket.description,
        category: ticket.category, priority: ticket.priority, status: ticket.status,
        requestor: ticket.requestor.name, assignee: ticket.assignee?.name ?? 'Unassigned', assigneeId: ticket.assigneeId,
        created: ticket.createdAt,
        responseSlaPct: slaPct(ticket.responseSlaDueAt, ticket.createdAt),
        resolutionSlaPct: slaPct(ticket.resolutionSlaDueAt, ticket.createdAt),
        notes: ticket.notes.map((n) => ({
          id: n.id, author: n.author.name, role: n.author.role,
          visibility: n.visibility, body: n.body, time: n.createdAt,
        })),
        timeline: ticket.events.map((e) => ({ time: e.createdAt, event: e.eventText })),
        attachments: ticket.attachments.map((a) => ({ id: a.id, filename: a.filename, sizeBytes: a.sizeBytes })),
      };
    });
  });

  const noteSchema = z.object({
    body: z.string().min(1),
    visibility: z.enum(['CUSTOMER', 'INTERNAL']).optional(),
  });

  // POST /api/incidents/:id/notes
  app.post('/api/incidents/:id/notes', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body is required' });

    // Customers can never post an internal-only note — force CUSTOMER
    // regardless of what's in the request payload.
    const visibility = isSupportRole(ctx.role) ? (parsed.data.visibility ?? 'CUSTOMER') : 'CUSTOMER';

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, type: 'INCIDENT', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
      });
      if (!ticket) return reply.code(404).send({ error: 'Incident not found' });

      const note = await tx.ticketNote.create({
        data: { ticketId: id, authorId: ctx.userId, visibility, body: parsed.data.body },
        include: { author: { select: { name: true, role: true } } },
      });
      await tx.ticketEvent.create({
        data: { ticketId: id, eventText: `${note.author.name} added a ${visibility === 'INTERNAL' ? 'internal ' : ''}note` },
      });

      // Notify the other party (customer note -> notify assignee; support
      // customer-visible note -> notify requestor). Internal notes never
      // trigger a customer notification.
      if (isSupportRole(ctx.role) && visibility === 'CUSTOMER') {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId, title: 'Update on your incident',
          sub: ticket.title, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'New update on your incident',
            intro: `${note.author.name} from the Doyensys support team has posted an update on your incident.`,
            accent: 'blue',
            ctaLabel: 'View the full ticket',
            note: { author: note.author.name, body: note.body },
            includeDescription: false,
          }),
        });
      } else if (!isSupportRole(ctx.role) && ticket.assigneeId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.assigneeId, title: 'Customer replied on an incident',
          sub: ticket.title, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'The customer has replied',
            intro: `${note.author.name} has added a comment to an incident assigned to you.`,
            accent: 'orange',
            ctaLabel: 'Open the ticket',
            note: { author: note.author.name, body: note.body },
            includeDescription: false,
          }),
        });
      }

      return { id: note.id, author: note.author.name, role: note.author.role, visibility: note.visibility, body: note.body, time: note.createdAt };
    });
  });

  const statusSchema = z.object({ status: z.enum(STATUS_ORDER) });

  // PATCH /api/incidents/:id/status — support only
  app.patch('/api/incidents/:id/status', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid status' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'INCIDENT' } });
      if (!ticket) return reply.code(404).send({ error: 'Incident not found' });

      // Named in the notification emails so the reader knows who acted,
      // rather than the change appearing to come from nobody.
      const actor = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      const actorName = actor?.name ?? 'The Doyensys support team';

      const closing = parsed.data.status === 'RESOLVED' || parsed.data.status === 'CLOSED';
      const updated = await tx.ticket.update({
        where: { id },
        data: {
          status: parsed.data.status,
          slaPausedAt: parsed.data.status === 'WAITING_ON_CUSTOMER' ? new Date() : null,
          // First time this ticket reaches Resolved/Closed, stamp it for trend
          // charts; reopening (any other status) clears it so it isn't
          // double-counted as closed if it's resolved again later.
          resolvedAt: closing ? (ticket.resolvedAt ?? new Date()) : null,
        },
      });
      const statusLabel = parsed.data.status.replace(/_/g, ' ');
      await tx.ticketEvent.create({
        data: { ticketId: id, eventText: `Status changed to ${statusLabel}` },
      });

      // Every status change is conveyed to the customer and to whoever the
      // ticket is currently assigned to — never to the whole support team
      // (that would be an email per agent on every single hop). Whoever
      // actually made this change doesn't need a notification about their
      // own action.
      const code = incidentCode(ticket.number);
      const prevLabel = (ticket.status ?? '').replace(/_/g, ' ');
      // What the new status actually means for the reader, in plain English.
      const meaning: Record<string, string> = {
        RESPONDED: 'A support engineer has picked this up and responded.',
        IN_PROGRESS: 'A support engineer is actively working on this now.',
        WAITING_ON_CUSTOMER: 'We need information from you before we can continue — the SLA clock is paused until you reply.',
        RESOLVED: 'We believe this is fixed. If it is still happening, reply on the ticket and we will reopen it.',
        CLOSED: 'This incident is now closed. No further action is needed.',
        RAISED: 'This incident has been reopened and is back in the queue.',
      };
      const statusRows = [
        { label: 'Previous status', value: prevLabel },
        { label: 'Changed by', value: actorName },
      ];
      if (ticket.requestorId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId,
          title: parsed.data.status === 'RESOLVED' ? 'Your incident was resolved' : `Your incident status changed to ${statusLabel}`,
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: parsed.data.status === 'RESOLVED' ? 'Your incident has been resolved' : `Status updated to ${statusLabel}`,
            intro: meaning[parsed.data.status] ?? `The status of your incident has changed to ${statusLabel}.`,
            accent: parsed.data.status === 'RESOLVED' || parsed.data.status === 'CLOSED' ? 'teal'
              : parsed.data.status === 'WAITING_ON_CUSTOMER' ? 'orange' : 'blue',
            ctaLabel: parsed.data.status === 'WAITING_ON_CUSTOMER' ? 'Reply on the ticket' : 'View the ticket',
            extraRows: statusRows,
            includeDescription: false,
          }),
        });
      }
      if (ticket.assigneeId && ticket.assigneeId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.assigneeId, title: `Incident status changed to ${statusLabel}`,
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Status changed to ${statusLabel}`,
            intro: `${actorName} changed the status of an incident assigned to you.`,
            accent: 'blue',
            ctaLabel: 'Open the ticket',
            extraRows: statusRows,
            includeDescription: false,
          }),
        });
      }
      return { id: updated.id, status: updated.status };
    });
  });

  const assigneeSchema = z.object({ assigneeId: z.string().uuid().nullable() });

  // PATCH /api/incidents/:id/assignee — support only. assigneeId: null unassigns.
  app.patch('/api/incidents/:id/assignee', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = assigneeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'assigneeId is required (or null to unassign)' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'INCIDENT' } });
      if (!ticket) return reply.code(404).send({ error: 'Incident not found' });

      let assigneeName = 'Unassigned';
      if (parsed.data.assigneeId) {
        const agent = await tx.user.findFirst({
          where: { id: parsed.data.assigneeId, role: { in: ['SUPPORT_AGENT', 'SUPPORT_MANAGER'] } },
        });
        if (!agent) return reply.code(400).send({ error: 'assigneeId must be a support agent or manager' });
        assigneeName = agent.name;
      }

      const updated = await tx.ticket.update({ where: { id }, data: { assigneeId: parsed.data.assigneeId } });
      await tx.ticketEvent.create({
        data: { ticketId: id, eventText: parsed.data.assigneeId ? `Assigned to ${assigneeName}` : 'Unassigned' },
      });

      if (parsed.data.assigneeId) {
        const code = incidentCode(ticket.number);
        const assigner = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
        const assignerName = assigner?.name ?? 'A support manager';
        const selfAssigned = parsed.data.assigneeId === ctx.userId;

        // The assignee gets their own personal heads-up...
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: parsed.data.assigneeId, title: 'An incident was assigned to you',
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'This incident is now yours',
            intro: selfAssigned
              ? 'You have taken ownership of this incident. The SLA clock below is now yours to meet.'
              : `${assignerName} has assigned this incident to you. The SLA clock below is now yours to meet.`,
            accent: 'red',
            ctaLabel: 'Start working on it',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
          }),
        });
        // ...the rest of the support team gets a heads-up who's on it...
        await notifyAllSupport(tx, {
          orgId: ticket.orgId, title: 'Incident assigned', sub: `${code} — ${ticket.title} — assigned to ${assigneeName}`,
          category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Incident assigned to ${assigneeName}`,
            intro: `For team visibility — no action needed from you unless ${assigneeName} asks for help.`,
            accent: 'grey',
            ctaLabel: 'View the ticket',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
            includeDescription: false,
          }),
        }, { excludeUserId: parsed.data.assigneeId });
        // ...and the customer learns who's working their issue.
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId, title: 'Your incident has been assigned',
          sub: `${code} — ${ticket.title} is now being handled by ${assigneeName}`,
          category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `${assigneeName} is now handling your incident`,
            intro: `Your incident has been picked up by a named engineer. They'll post updates on the ticket as they work through it, and you'll be emailed each time.`,
            accent: 'teal',
            ctaLabel: 'View your ticket',
            includeDescription: false,
          }),
        });
      }

      return { id: updated.id, assignee: assigneeName, assigneeId: updated.assigneeId };
    });
  });

  const createSchema = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']),
    category: z.string().optional(),
  });

  // POST /api/incidents — creation form (product decision #4)
  app.post('/api/incidents', auth, async (req, reply) => {
    const ctx = req.authContext;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'title, description, and priority are required' });

    return withTenantContext(ctx, async (tx) => {
      const slaHours: Record<string, number> = { P1: 4, P2: 8, P3: 24, P4: 72 };
      const hours = slaHours[parsed.data.priority];
      const ticket = await tx.ticket.create({
        data: {
          orgId: ctx.orgId, type: 'INCIDENT', title: parsed.data.title, description: parsed.data.description,
          priority: parsed.data.priority, category: parsed.data.category, status: 'RAISED',
          requestorId: ctx.userId,
          responseSlaDueAt: new Date(Date.now() + hours * 60 * 60 * 1000 * 0.25),
          resolutionSlaDueAt: new Date(Date.now() + hours * 60 * 60 * 1000),
        },
      });
      await tx.ticketEvent.create({ data: { ticketId: ticket.id, eventText: 'Ticket created' } });
      const code = incidentCode(ticket.number);
      const P_MEANING: Record<string, string> = {
        P1: 'P1 — critical. Business is down or severely impacted; this needs immediate attention.',
        P2: 'P2 — high. Significant impact with no workaround.',
        P3: 'P3 — medium. Normal business impact, workaround may exist.',
        P4: 'P4 — low. Minor issue or question.',
      };
      // The whole support team hears about the new incident...
      await notifyAllSupport(tx, {
        orgId: ticket.orgId, title: 'New incident created', sub: `${code} — ${parsed.data.title} (${parsed.data.priority})`,
        category: 'TICKET', refType: 'ticket', refId: ticket.id,
        email: await ticketEmailDetail(tx, ticket.id, {
          headline: `New ${parsed.data.priority} incident raised`,
          intro: `${P_MEANING[parsed.data.priority] ?? ''} This incident is unassigned — please pick it up or assign it to whoever should own it.`,
          accent: parsed.data.priority === 'P1' ? 'red' : parsed.data.priority === 'P2' ? 'orange' : 'blue',
          ctaLabel: 'Assign this incident',
        }),
      });
      // ...and the customer who raised it gets a confirmation it was received.
      await notifyAndEmail(tx, {
        orgId: ticket.orgId, userId: ctx.userId, title: 'We received your incident',
        sub: `${code} — ${parsed.data.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
        email: await ticketEmailDetail(tx, ticket.id, {
          headline: 'We have received your incident',
          intro: `Your incident is logged as ${code} and the Doyensys support team has been notified. We'll email you as soon as an engineer picks it up, and at every step after that.`,
          accent: 'teal',
          ctaLabel: 'Track your ticket',
        }),
      });
      return reply.code(201).send({ id: ticket.id });
    });
  });
}
