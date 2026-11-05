import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';
import { notifyAndEmail, notifyAllSupport } from '../lib/notify';
import { ticketEmailDetail } from '../lib/ticketEmail';

const STATUS_ORDER = ['RAISED', 'RESPONDED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] as const;

function slaPct(dueAt: Date | null, createdAt: Date): number | null {
  if (!dueAt) return null;
  const total = dueAt.getTime() - createdAt.getTime();
  const elapsed = Date.now() - createdAt.getTime();
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}
function requestCode(number: number) { return `REQ${String(number).padStart(6, '0')}`; }

export async function requestsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/requests', auth, async (req) => {
    const ctx = req.authContext;
    const mine = (req.query as any).mine === 'true';
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);
      const mineFilter = mine ? { requestorId: ctx.userId } : {};
      const tickets = await tx.ticket.findMany({
        where: { ...orgFilter, ...mineFilter, type: 'REQUEST' },
        include: { requestor: { select: { name: true } }, assignee: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return tickets.map((t) => ({
        id: t.id, code: requestCode(t.number), title: t.title, type: t.category, priority: t.priority, status: t.status,
        requestor: t.requestor.name, assignee: t.assignee?.name ?? 'Unassigned', assigneeId: t.assigneeId,
        created: t.createdAt, slaPct: slaPct(t.resolutionSlaDueAt, t.createdAt),
      }));
    });
  });

  app.get('/api/requests/:id', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, type: 'REQUEST', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: {
          requestor: { select: { name: true } }, assignee: { select: { name: true } },
          notes: { include: { author: { select: { name: true, role: true } } }, orderBy: { createdAt: 'asc' } },
          attachments: true,
        },
      });
      if (!ticket) return reply.code(404).send({ error: 'Request not found' });
      return {
        id: ticket.id, code: requestCode(ticket.number), title: ticket.title, description: ticket.description, type: ticket.category,
        priority: ticket.priority, status: ticket.status, requestor: ticket.requestor.name,
        assignee: ticket.assignee?.name ?? 'Unassigned', assigneeId: ticket.assigneeId, created: ticket.createdAt,
        slaPct: slaPct(ticket.resolutionSlaDueAt, ticket.createdAt),
        notes: ticket.notes.map((n) => ({ id: n.id, author: n.author.name, role: n.author.role, body: n.body, time: n.createdAt })),
        attachments: ticket.attachments.map((a) => ({ id: a.id, filename: a.filename, sizeBytes: a.sizeBytes })),
      };
    });
  });

  const noteSchema = z.object({ body: z.string().min(1) });

  app.post('/api/requests/:id/notes', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body is required' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'REQUEST', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) } });
      if (!ticket) return reply.code(404).send({ error: 'Request not found' });

      // All request notes are customer-visible — no internal/customer split
      // for this ticket type, per the prototype's design.
      const note = await tx.ticketNote.create({
        data: { ticketId: id, authorId: ctx.userId, visibility: 'CUSTOMER', body: parsed.data.body },
        include: { author: { select: { name: true, role: true } } },
      });

      if (isSupportRole(ctx.role)) {
        await notifyAndEmail(tx, { orgId: ticket.orgId, userId: ticket.requestorId, title: 'Update on your request', sub: ticket.title, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'New update on your request',
            intro: `${note.author.name} from the Doyensys support team has posted an update on your service request.`,
            accent: 'blue',
            ctaLabel: 'View the full request',
            note: { author: note.author.name, body: note.body },
            includeDescription: false,
          }),
        });
      } else if (ticket.assigneeId) {
        await notifyAndEmail(tx, { orgId: ticket.orgId, userId: ticket.assigneeId, title: 'Customer replied on a request', sub: ticket.title, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'The customer has replied',
            intro: `${note.author.name} has added a comment to a request assigned to you.`,
            accent: 'orange',
            ctaLabel: 'Open the request',
            note: { author: note.author.name, body: note.body },
            includeDescription: false,
          }),
        });
      }

      return { id: note.id, author: note.author.name, role: note.author.role, body: note.body, time: note.createdAt };
    });
  });

  const statusSchema = z.object({ status: z.enum(STATUS_ORDER) });

  app.patch('/api/requests/:id/status', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid status' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'REQUEST' } });
      if (!ticket) return reply.code(404).send({ error: 'Request not found' });
      const closing = parsed.data.status === 'RESOLVED' || parsed.data.status === 'CLOSED';
      const updated = await tx.ticket.update({
        where: { id },
        data: {
          status: parsed.data.status,
          slaPausedAt: parsed.data.status === 'WAITING_ON_CUSTOMER' ? new Date() : null,
          resolvedAt: closing ? (ticket.resolvedAt ?? new Date()) : null,
        },
      });
      const statusLabel = parsed.data.status.replace(/_/g, ' ');
      const code = requestCode(ticket.number);
      const actor = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      const actorName = actor?.name ?? 'The Doyensys support team';
      const meaning: Record<string, string> = {
        RESPONDED: 'A support engineer has picked this up and responded.',
        IN_PROGRESS: 'A support engineer is actively working on this now.',
        WAITING_ON_CUSTOMER: 'We need information from you before we can continue — the SLA clock is paused until you reply.',
        RESOLVED: 'This request has been fulfilled. If something is missing, reply on the ticket and we will reopen it.',
        CLOSED: 'This request is now closed. No further action is needed.',
        RAISED: 'This request has been reopened and is back in the queue.',
      };
      const statusRows = [
        { label: 'Previous status', value: (ticket.status ?? '').replace(/_/g, ' ') },
        { label: 'Changed by', value: actorName },
      ];
      if (ticket.requestorId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId,
          title: parsed.data.status === 'RESOLVED' ? 'Your request was resolved' : `Your request status changed to ${statusLabel}`,
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: parsed.data.status === 'RESOLVED' ? 'Your request has been fulfilled' : `Status updated to ${statusLabel}`,
            intro: meaning[parsed.data.status] ?? `The status of your request has changed to ${statusLabel}.`,
            accent: parsed.data.status === 'RESOLVED' || parsed.data.status === 'CLOSED' ? 'teal'
              : parsed.data.status === 'WAITING_ON_CUSTOMER' ? 'orange' : 'blue',
            ctaLabel: parsed.data.status === 'WAITING_ON_CUSTOMER' ? 'Reply on the ticket' : 'View the request',
            extraRows: statusRows,
            includeDescription: false,
          }),
        });
      }
      if (ticket.assigneeId && ticket.assigneeId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.assigneeId, title: `Request status changed to ${statusLabel}`,
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Status changed to ${statusLabel}`,
            intro: `${actorName} changed the status of a request assigned to you.`,
            accent: 'blue',
            ctaLabel: 'Open the request',
            extraRows: statusRows,
            includeDescription: false,
          }),
        });
      }
      return { id: updated.id, status: updated.status };
    });
  });

  const assigneeSchema = z.object({ assigneeId: z.string().uuid().nullable() });

  // PATCH /api/requests/:id/assignee — support only. assigneeId: null unassigns.
  app.patch('/api/requests/:id/assignee', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = assigneeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'assigneeId is required (or null to unassign)' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'REQUEST' } });
      if (!ticket) return reply.code(404).send({ error: 'Request not found' });

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
        const code = requestCode(ticket.number);
        const assigner = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
        const assignerName = assigner?.name ?? 'A support manager';
        const selfAssigned = parsed.data.assigneeId === ctx.userId;

        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: parsed.data.assigneeId, title: 'A request was assigned to you',
          sub: `${code} — ${ticket.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'This request is now yours',
            intro: selfAssigned
              ? 'You have taken ownership of this service request. The SLA clock below is now yours to meet.'
              : `${assignerName} has assigned this service request to you. The SLA clock below is now yours to meet.`,
            accent: 'red',
            ctaLabel: 'Start working on it',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
          }),
        });
        await notifyAllSupport(tx, {
          orgId: ticket.orgId, title: 'Request assigned', sub: `${code} — ${ticket.title} — assigned to ${assigneeName}`,
          category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Request assigned to ${assigneeName}`,
            intro: `For team visibility — no action needed from you unless ${assigneeName} asks for help.`,
            accent: 'grey',
            ctaLabel: 'View the request',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
            includeDescription: false,
          }),
        }, { excludeUserId: parsed.data.assigneeId });
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId, title: 'Your request has been assigned',
          sub: `${code} — ${ticket.title} is now being handled by ${assigneeName}`,
          category: 'TICKET', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `${assigneeName} is now handling your request`,
            intro: `Your service request has been picked up by a named engineer. They'll post updates on the ticket as they work through it, and you'll be emailed each time.`,
            accent: 'teal',
            ctaLabel: 'View your request',
            includeDescription: false,
          }),
        });
      }

      return { id: updated.id, assignee: assigneeName, assigneeId: updated.assigneeId };
    });
  });

  const createSchema = z.object({
    title: z.string().min(1), description: z.string().min(1),
    priority: z.enum(['P1', 'P2', 'P3', 'P4']), type: z.string().min(1),
  });

  app.post('/api/requests', auth, async (req, reply) => {
    const ctx = req.authContext;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'title, description, priority, and type are required' });

    return withTenantContext(ctx, async (tx) => {
      const slaHours: Record<string, number> = { P1: 8, P2: 24, P3: 48, P4: 120 };
      const ticket = await tx.ticket.create({
        data: {
          orgId: ctx.orgId, type: 'REQUEST', title: parsed.data.title, description: parsed.data.description,
          priority: parsed.data.priority, category: parsed.data.type, status: 'RAISED', requestorId: ctx.userId,
          resolutionSlaDueAt: new Date(Date.now() + slaHours[parsed.data.priority] * 60 * 60 * 1000),
        },
      });
      const code = requestCode(ticket.number);
      await notifyAllSupport(tx, {
        orgId: ticket.orgId, title: 'New request created', sub: `${code} — ${parsed.data.title} (${parsed.data.type})`,
        category: 'TICKET', refType: 'ticket', refId: ticket.id,
        email: await ticketEmailDetail(tx, ticket.id, {
          headline: `New ${parsed.data.type} request raised`,
          intro: 'This service request is unassigned — please pick it up or assign it to whoever should own it.',
          accent: parsed.data.priority === 'P1' ? 'red' : parsed.data.priority === 'P2' ? 'orange' : 'blue',
          ctaLabel: 'Assign this request',
        }),
      });
      await notifyAndEmail(tx, {
        orgId: ticket.orgId, userId: ctx.userId, title: 'We received your request',
        sub: `${code} — ${parsed.data.title}`, category: 'TICKET', refType: 'ticket', refId: ticket.id,
        email: await ticketEmailDetail(tx, ticket.id, {
          headline: 'We have received your request',
          intro: `Your service request is logged as ${code} and the Doyensys support team has been notified. We'll email you as soon as an engineer picks it up, and at every step after that.`,
          accent: 'teal',
          ctaLabel: 'Track your request',
        }),
      });
      return reply.code(201).send({ id: ticket.id });
    });
  });
}
