import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthContext } from '../lib/tenantContext';

declare module 'fastify' {
  interface FastifyRequest {
    authContext: AuthContext;
  }
  interface FastifyInstance {
    authenticate: typeof authenticate;
  }
}

/**
 * Verifies the Bearer JWT (via @fastify/jwt, registered in server.ts) and
 * populates request.authContext for downstream handlers. Register as a
 * preHandler on every route except /api/auth/login and /health.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await req.jwtVerify<{
      sub: string;
      orgId: string;
      role: AuthContext['role'];
    }>();
    req.authContext = {
      userId: payload.sub,
      orgId: payload.orgId,
      role: payload.role,
    };
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
  }
}

/** Route guard: only SUPPORT_AGENT / SUPPORT_MANAGER may proceed. */
export async function requireSupport(req: FastifyRequest, reply: FastifyReply) {
  if (req.authContext.role !== 'SUPPORT_AGENT' && req.authContext.role !== 'SUPPORT_MANAGER') {
    reply.code(403).send({ error: 'Support staff only' });
  }
}
