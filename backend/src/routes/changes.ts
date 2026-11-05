import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';
import { CHANGE_TRANSITIONS, isActorAllowed } from '../workflow/changeWorkflow';
import { notifyAndEmail, notifyAllSupport } from '../lib/notify';
import { ticketEmailDetail } from '../lib/ticketEmail';

const STAGE_LABEL: Record<string, string> = {
  RAISED: 'Raised', CUSTOMER_APPROVAL: 'Customer Approval', DEV: 'Development',
  DEV_REVIEW: 'Development Review', TEST: 'Testing', TEST_REVIEW: 'Test Review',
  PROD: 'Production', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
function changeCode(number: number) { return `CHG${String(number).padStart(6, '0')}`; }

export async function changesRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  app.get('/api/changes', auth, async (req) => {
    const ctx = req.authContext;
    const orgId = (req.query as any).orgId as string | undefined;
    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, orgId);
      const tickets = await tx.ticket.findMany({
        where: { ...orgFilter, type: 'CHANGE' },
        include: { requestor: { select: { name: true } }, assignee: { select: { name: true } }, changeDetail: true },
        orderBy: { createdAt: 'desc' },
      });
      return tickets
        .filter((t) => t.changeDetail)
        .map((t) => ({
          id: t.id, code: changeCode(t.number), title: t.title, risk: t.changeDetail!.risk, priority: t.priority,
          requestor: t.requestor.name, assignee: t.assignee?.name ?? 'Unassigned', assigneeId: t.assigneeId,
          stage: t.changeDetail!.stage, stageLabel: STAGE_LABEL[t.changeDetail!.stage],
        }));
    });
  });

  app.get('/api/changes/:id', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, type: 'CHANGE', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: {
          requestor: { select: { name: true } },
          assignee: { select: { name: true } },
          org: { select: { name: true } },
          changeDetail: {
            include: {
              history: { include: { by: { select: { name: true, role: true } } }, orderBy: { createdAt: 'asc' } },
            },
          },
          attachments: true,
        },
      });
      if (!ticket || !ticket.changeDetail) return reply.code(404).send({ error: 'Change not found' });
      const cd = ticket.changeDetail;

      const availableActions = Object.entries(CHANGE_TRANSITIONS[cd.stage] ?? {})
        .filter(([, def]) => isActorAllowed(def.actor, ctx.role))
        .map(([action, def]) => ({ action, label: def.label }));

      return {
        id: ticket.id, code: changeCode(ticket.number), title: ticket.title, requestor: ticket.requestor.name, customer: ticket.org.name,
        assignee: ticket.assignee?.name ?? 'Unassigned', assigneeId: ticket.assigneeId,
        risk: cd.risk, priority: ticket.priority, justification: cd.justification, impact: cd.impact,
        implementation: cd.implementation, rollback: cd.rollback,
        stage: cd.stage, stageLabel: STAGE_LABEL[cd.stage],
        devNotes: cd.devNotes, devCompletedDate: cd.devCompletedAt,
        testNotes: cd.testNotes, prodNotes: cd.prodNotes, deployedDate: cd.deployedAt,
        history: cd.history.map((h) => ({ stage: h.stage, by: h.by.name, role: h.by.role, time: h.createdAt, note: h.note })),
        attachments: ticket.attachments.map((a) => ({ id: a.id, filename: a.filename, sizeBytes: a.sizeBytes })),
        availableActions,
      };
    });
  });

  const transitionSchema = z.object({ action: z.string().min(1), note: z.string().optional() });

  app.post('/api/changes/:id/transition', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = transitionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'action is required' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, type: 'CHANGE', ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
        include: { changeDetail: true },
      });
      if (!ticket || !ticket.changeDetail) return reply.code(404).send({ error: 'Change not found' });

      const currentStage = ticket.changeDetail.stage;
      const def = CHANGE_TRANSITIONS[currentStage]?.[parsed.data.action];
      if (!def) return reply.code(400).send({ error: `Action "${parsed.data.action}" is not valid from stage ${currentStage}` });
      if (!isActorAllowed(def.actor, ctx.role)) return reply.code(403).send({ error: 'You are not permitted to perform this action' });

      const evidenceUpdate: Record<string, any> = {};
      if (def.evidenceField) {
        evidenceUpdate[def.evidenceField] = parsed.data.note ?? def.label;
        if (def.evidenceField === 'devNotes') {
          evidenceUpdate.devById = ctx.userId;
          evidenceUpdate.devCompletedAt = new Date();
        }
        if (def.evidenceField === 'prodNotes') {
          evidenceUpdate.deployedById = ctx.userId;
          evidenceUpdate.deployedAt = new Date();
        }
      }

      await tx.changeDetail.update({ where: { ticketId: id }, data: { stage: def.to, ...evidenceUpdate } });
      // Stamp the ticket's resolvedAt the first time this change reaches
      // Resolved/Closed, so it shows up correctly in trend charts.
      const closingStage = def.to === 'RESOLVED' || def.to === 'CLOSED';
      if (closingStage && !ticket.resolvedAt) {
        await tx.ticket.update({ where: { id }, data: { resolvedAt: new Date() } });
      }
      await tx.changeHistory.create({
        data: { changeId: id, stage: STAGE_LABEL[def.to], byId: ctx.userId, note: parsed.data.note ?? def.label },
      });
      await tx.ticketEvent.create({ data: { ticketId: id, eventText: `${def.label} — moved to ${STAGE_LABEL[def.to]}` } });

      // Every stage transition is conveyed to the customer and to whoever
      // the change is currently assigned to — whoever just performed this
      // action doesn't need to be told about their own action.
      const code = changeCode(ticket.number);
      const notifyCustomer = def.actor === 'SUPPORT';
      const title = notifyCustomer ? 'Change needs your review' : `Change updated: ${STAGE_LABEL[def.to]}`;

      const actor = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      const actorName = actor?.name ?? 'The Doyensys support team';
      // What this stage actually asks of the reader. Change requests move
      // through an approval workflow, so "what do I do now" matters more
      // here than on an incident.
      const STAGE_MEANING: Record<string, string> = {
        CUSTOMER_APPROVAL: 'This change is waiting for your approval before work can begin. Please review it in the portal and approve or reject.',
        DEV: 'Development work on this change has started.',
        DEV_REVIEW: 'Development is complete and the change is ready for your review before it moves to testing.',
        TEST: 'This change is now being tested.',
        TEST_REVIEW: 'Testing is complete. Please review the results and approve the move to production.',
        PROD: 'This change has been deployed to production.',
        RESOLVED: 'This change is complete and has been resolved.',
        CLOSED: 'This change is now closed. No further action is needed.',
        RAISED: 'This change has been raised and is awaiting triage.',
      };
      const needsCustomerAction = ['CUSTOMER_APPROVAL', 'DEV_REVIEW', 'TEST_REVIEW'].includes(def.to);
      const stageRows = [
        { label: 'Previous stage', value: STAGE_LABEL[currentStage] ?? currentStage },
        { label: 'Action taken', value: def.label },
        { label: 'Actioned by', value: actorName },
      ];
      const stageNote = parsed.data.note ? { author: actorName, body: parsed.data.note } : null;

      if (ticket.requestorId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId, title,
          sub: `${code} — ${ticket.title}`, category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: needsCustomerAction ? 'This change needs your review' : `Change moved to ${STAGE_LABEL[def.to]}`,
            intro: STAGE_MEANING[def.to] ?? `This change request has moved to ${STAGE_LABEL[def.to]}.`,
            accent: needsCustomerAction ? 'orange'
              : def.to === 'RESOLVED' || def.to === 'CLOSED' ? 'teal' : 'blue',
            ctaLabel: needsCustomerAction ? 'Review and approve' : 'View the change',
            extraRows: stageRows,
            note: stageNote,
            includeDescription: false,
          }),
        });
      }
      if (ticket.assigneeId && ticket.assigneeId !== ctx.userId) {
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.assigneeId, title: `Change updated: ${STAGE_LABEL[def.to]}`,
          sub: `${code} — ${ticket.title}`, category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Change moved to ${STAGE_LABEL[def.to]}`,
            intro: `${actorName} moved a change request assigned to you into ${STAGE_LABEL[def.to]}.`,
            accent: 'blue',
            ctaLabel: 'Open the change',
            extraRows: stageRows,
            note: stageNote,
            includeDescription: false,
          }),
        });
      }

      return { id, stage: def.to, stageLabel: STAGE_LABEL[def.to] };
    });
  });

  const assigneeSchema = z.object({ assigneeId: z.string().uuid().nullable() });

  // PATCH /api/changes/:id/assignee — support only. assigneeId: null unassigns.
  app.patch('/api/changes/:id/assignee', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const parsed = assigneeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'assigneeId is required (or null to unassign)' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id, type: 'CHANGE' } });
      if (!ticket) return reply.code(404).send({ error: 'Change not found' });

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
        const code = changeCode(ticket.number);
        const assigner = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
        const assignerName = assigner?.name ?? 'A support manager';
        const selfAssigned = parsed.data.assigneeId === ctx.userId;

        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: parsed.data.assigneeId, title: 'A change request was assigned to you',
          sub: `${code} — ${ticket.title}`, category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'This change request is now yours',
            intro: selfAssigned
              ? 'You have taken ownership of this change request. You are responsible for moving it through the approval workflow.'
              : `${assignerName} has assigned this change request to you. You are responsible for moving it through the approval workflow.`,
            accent: 'red',
            ctaLabel: 'Start working on it',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
          }),
        });
        await notifyAllSupport(tx, {
          orgId: ticket.orgId, title: 'Change assigned', sub: `${code} — ${ticket.title} — assigned to ${assigneeName}`,
          category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `Change assigned to ${assigneeName}`,
            intro: `For team visibility — no action needed from you unless ${assigneeName} asks for help.`,
            accent: 'grey',
            ctaLabel: 'View the change',
            extraRows: [{ label: 'Assigned by', value: assignerName }],
            includeDescription: false,
          }),
        }, { excludeUserId: parsed.data.assigneeId });
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ticket.requestorId, title: 'Your change request has been assigned',
          sub: `${code} — ${ticket.title} is now being handled by ${assigneeName}`,
          category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: `${assigneeName} is now handling your change request`,
            intro: `Your change request has been picked up by a named engineer. You'll be emailed at each stage, and whenever it needs your approval.`,
            accent: 'teal',
            ctaLabel: 'View your change request',
            includeDescription: false,
          }),
        });
      }

      return { id: updated.id, assignee: assigneeName, assigneeId: updated.assigneeId };
    });
  });

  const createSchema = z.object({
    title: z.string().min(1), justification: z.string().min(1), impact: z.string().min(1),
    implementation: z.string().min(1), rollback: z.string().min(1),
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH']), priority: z.enum(['P1', 'P2', 'P3', 'P4']),
    // Required when support creates the change — support has no "own"
    // customer org, so they must say which customer this is for. Ignored
    // for customer-created changes, which always belong to their own org.
    orgId: z.string().optional(),
  });

  app.post('/api/changes', auth, async (req, reply) => {
    const ctx = req.authContext;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'All change fields are required' });

    let targetOrgId = ctx.orgId;
    if (isSupportRole(ctx.role)) {
      if (!parsed.data.orgId) return reply.code(400).send({ error: 'orgId is required when support creates a change' });
      targetOrgId = parsed.data.orgId;
    }

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.create({
        data: {
          orgId: targetOrgId, type: 'CHANGE', title: parsed.data.title,
          description: parsed.data.justification, priority: parsed.data.priority, requestorId: ctx.userId,
        },
      });
      await tx.changeDetail.create({
        data: {
          ticketId: ticket.id, risk: parsed.data.risk, justification: parsed.data.justification,
          impact: parsed.data.impact, implementation: parsed.data.implementation, rollback: parsed.data.rollback,
          stage: 'CUSTOMER_APPROVAL',
        },
      });
      await tx.changeHistory.create({ data: { changeId: ticket.id, stage: 'Raised', byId: ctx.userId, note: 'Change request submitted.' } });
      const code = changeCode(ticket.number);
      // The change's own fields are what reviewers actually need to judge it,
      // so they're surfaced in the email rather than making everyone open the
      // portal to find out what is being changed and how risky it is.
      const changeRows = [
        { label: 'Impact', value: parsed.data.impact },
        { label: 'Implementation', value: parsed.data.implementation },
        { label: 'Rollback plan', value: parsed.data.rollback },
      ];
      await notifyAllSupport(tx, {
        orgId: ticket.orgId, title: 'New change request submitted', sub: `${code} — ${parsed.data.title} (${parsed.data.risk} risk)`,
        category: 'CHANGE', refType: 'ticket', refId: ticket.id,
        email: await ticketEmailDetail(tx, ticket.id, {
          headline: `New ${parsed.data.risk.toLowerCase()}-risk change request`,
          intro: 'A change request has been submitted and is waiting on customer approval before work can begin. It is currently unassigned.',
          accent: parsed.data.risk === 'HIGH' ? 'red' : parsed.data.risk === 'MEDIUM' ? 'orange' : 'blue',
          ctaLabel: 'Assign this change',
          extraRows: changeRows,
        }),
      });
      if (isSupportRole(ctx.role)) {
        // If support created this on the customer's behalf, the customer
        // needs to know it's waiting on their approval — there's no single
        // customer "requestor" to notify in that case, so notify everyone on
        // the customer side.
        const customerUsers = await tx.user.findMany({ where: { orgId: targetOrgId, role: { in: ['CUSTOMER_ADMIN', 'CUSTOMER_VIEWER'] } } });
        const raisedByDetail = await ticketEmailDetail(tx, ticket.id, {
          headline: 'A change request needs your approval',
          intro: 'Doyensys has raised a change request on your environment. Nothing will be implemented until you approve it — please review the impact, implementation and rollback plan below.',
          accent: 'orange',
          ctaLabel: 'Review and approve',
          extraRows: changeRows,
        });
        for (const u of customerUsers) {
          await notifyAndEmail(tx, {
            orgId: targetOrgId, userId: u.id, title: 'New change request awaiting your approval',
            sub: `${code} — ${parsed.data.title}`, category: 'CHANGE', refType: 'ticket', refId: ticket.id,
            email: raisedByDetail,
          });
        }
      } else {
        // Customer created it themselves — send them a confirmation it was received.
        await notifyAndEmail(tx, {
          orgId: ticket.orgId, userId: ctx.userId, title: 'We received your change request',
          sub: `${code} — ${parsed.data.title}`, category: 'CHANGE', refType: 'ticket', refId: ticket.id,
          email: await ticketEmailDetail(tx, ticket.id, {
            headline: 'We have received your change request',
            intro: `Your change request is logged as ${code}. The Doyensys team will review it and move it through development, testing and production — you'll be emailed at each stage and whenever it needs your approval.`,
            accent: 'teal',
            ctaLabel: 'Track your change request',
            extraRows: changeRows,
          }),
        });
      }
      return reply.code(201).send({ id: ticket.id });
    });
  });
}
