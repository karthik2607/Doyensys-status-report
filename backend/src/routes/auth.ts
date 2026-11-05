import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attemptLogin } from '../services/authService';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login
  // Public route — no authenticate preHandler.
  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'email and password are required' });
    }

    const result = await attemptLogin(parsed.data.email, parsed.data.password);
    if (!result) {
      // Deliberately generic — don't reveal whether the email exists.
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const token = app.jwt.sign(
      { sub: result.user.id, orgId: result.user.orgId, role: result.user.role },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' }
    );

    return reply.send({ token, user: result.user });
  });

  // GET /api/auth/org-brand?domain=petmate.com
  // Public route — no authenticate preHandler. Used by the login page to
  // preview a customer's logo/name as soon as their email domain is
  // recognized, BEFORE they've entered a password or been authenticated.
  //
  // This is cosmetic only — it never grants access to anything. The org
  // that actually gets attached to a session comes from the authenticated
  // user's own `orgId` (set when their account was created), never from
  // this lookup or from the email domain itself. An email domain isn't
  // proof of identity, so treating it as one here would be a security bug.
  //
  // orgs/org_settings have row-level security that normally only lets a
  // caller see their own org (or lets support see everything). There's no
  // authenticated caller here at all, so this runs inside a transaction
  // that explicitly grants itself the same "see every org" visibility
  // support staff already have — safe, because the only data returned is
  // a customer's name and public logo URL, which is meant to be visible
  // on a login screen.
  app.get('/api/auth/org-brand', async (req, reply) => {
    const { domain } = req.query as { domain?: string };
    if (!domain || !domain.trim()) return reply.send({ matched: false });

    const { prisma } = await import('../lib/prisma');
    const org = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.role = 'SUPPORT_AGENT'`);
      return tx.org.findFirst({
        where: { emailDomain: domain.toLowerCase().trim(), type: 'CUSTOMER' },
        include: { settings: { select: { logoUrl: true } } },
      });
    });

    if (!org) return reply.send({ matched: false });
    return reply.send({ matched: true, orgName: org.name, logoUrl: org.settings?.logoUrl ?? null });
  });

  // GET /api/auth/me — used by the frontend on page load to restore session
  // state from a stored token without re-prompting for credentials.
  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req, reply) => {
    const { prisma } = await import('../lib/prisma');
    const user = await prisma.user.findUnique({
      where: { id: req.authContext.userId },
      include: { org: { include: { settings: { select: { logoUrl: true } } } } },
    });
    if (!user) return reply.code(404).send({ error: 'User not found' });

    return reply.send({
      user: {
        id: user.id,
        orgId: user.orgId,
        orgName: user.org.name,
        orgType: user.org.type,
        orgLogoUrl: user.org.settings?.logoUrl ?? null,
        name: user.name,
        initials: user.initials,
        email: user.email,
        role: user.role,
      },
    });
  });
}
