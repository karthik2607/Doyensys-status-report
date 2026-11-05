import { FastifyInstance } from 'fastify';
import { withTenantContext, isSupportRole } from '../lib/tenantContext';

export async function usersRoutes(app: FastifyInstance) {
  // GET /api/support-users — support staff only. Used to populate the
  // "Assign to" dropdown on tickets. Always queried live from the DB, so a
  // newly created support account (via scripts/createAccount.ts) shows up
  // here automatically on the very next request — nothing to hardcode or
  // redeploy on the frontend.
  app.get('/api/support-users', {
    preHandler: [app.authenticate, async (req, reply) => {
      if (!isSupportRole(req.authContext.role)) reply.code(403).send({ error: 'Support staff only' });
    }],
  }, async (req) => {
    const ctx = req.authContext;
    return withTenantContext(ctx, async (tx) => {
      const users = await tx.user.findMany({
        where: { role: { in: ['SUPPORT_AGENT', 'SUPPORT_MANAGER'] } },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: 'asc' },
      });
      return users;
    });
  });
}
