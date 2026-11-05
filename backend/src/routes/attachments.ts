import { FastifyInstance } from 'fastify';
import { withTenantContext, isSupportRole } from '../lib/tenantContext';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function attachmentsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  const dir = process.env.ATTACHMENTS_DIR ?? '/opt/doyensys/uploads';

  // POST /api/tickets/:id/attachments — multipart upload, works for
  // incidents, requests, and changes alike (all share the `tickets` table).
  app.post('/api/tickets/:id/attachments', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });

    return withTenantContext(ctx, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id, ...(isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId }) },
      });
      if (!ticket) return reply.code(404).send({ error: 'Ticket not found' });

      fs.mkdirSync(dir, { recursive: true });
      const storedName = `${randomUUID()}-${file.filename}`;
      const storedPath = path.join(dir, storedName);
      const buffer = await file.toBuffer();
      fs.writeFileSync(storedPath, buffer);

      const attachment = await tx.ticketAttachment.create({
        data: {
          ticketId: id, uploadedById: ctx.userId, filename: file.filename,
          storedPath, mimeType: file.mimetype, sizeBytes: buffer.length,
        },
      });
      await tx.ticketEvent.create({ data: { ticketId: id, eventText: `Attachment uploaded: ${file.filename}` } });

      return reply.code(201).send({ id: attachment.id, filename: attachment.filename, sizeBytes: attachment.sizeBytes });
    });
  });

  // GET /api/attachments/:id/download
  app.get('/api/attachments/:id/download', auth, async (req, reply) => {
    const ctx = req.authContext;
    const { id } = req.params as { id: string };
    return withTenantContext(ctx, async (tx) => {
      const attachment = await tx.ticketAttachment.findFirst({
        where: { id, ticket: isSupportRole(ctx.role) ? {} : { orgId: ctx.orgId } },
      });
      if (!attachment || !fs.existsSync(attachment.storedPath)) {
        return reply.code(404).send({ error: 'Attachment not found' });
      }
      reply.header('Content-Disposition', `attachment; filename="${attachment.filename}"`);
      reply.type(attachment.mimeType);
      return reply.send(fs.createReadStream(attachment.storedPath));
    });
  });
}
