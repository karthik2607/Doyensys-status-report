import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';

export async function notificationsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  // GET /api/notifications
  app.get('/api/notifications', auth, async (req) => {
    return prisma.notification.findMany({
      where: { userId: req.authContext.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  // GET /api/notifications?unread=true&count=true — used for the bell badge
  app.get('/api/notifications/unread-count', auth, async (req) => {
    const count = await prisma.notification.count({
      where: { userId: req.authContext.userId, isRead: false },
    });
    return { count };
  });

  // POST /api/notifications/mark-all-read — called when the Notifications page loads
  app.post('/api/notifications/mark-all-read', auth, async (req) => {
    await prisma.notification.updateMany({
      where: { userId: req.authContext.userId, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  });
}
