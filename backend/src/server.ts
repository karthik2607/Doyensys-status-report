import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { authenticate } from './middleware/authenticate';
import { authRoutes } from './routes/auth';
import { dashboardRoutes } from './routes/dashboard';
import { projectsRoutes } from './routes/projects';
import { notificationsRoutes } from './routes/notifications';
import { usersRoutes } from './routes/users';
import { incidentsRoutes } from './routes/incidents';
import { requestsRoutes } from './routes/requests';
import { changesRoutes } from './routes/changes';
import { attachmentsRoutes } from './routes/attachments';
import { statusReportsRoutes } from './routes/statusReports';
import { trendsRoutes } from './routes/trends';
import { brandingRoutes } from './routes/branding';
import { weeklyReportRoutes } from './routes/weeklyReport';
import { startEmailIngestion } from './services/emailIngestion';

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? (() => {
      throw new Error('JWT_SECRET is not set in .env');
    })(),
  });

  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.ATTACHMENT_MAX_SIZE_MB ?? 25) * 1024 * 1024,
    },
  });

  // Expose `authenticate` as app.authenticate so routes can do
  // { preHandler: app.authenticate }
  app.decorate('authenticate', authenticate);

  app.get('/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
  await app.register(projectsRoutes);
  await app.register(notificationsRoutes);
  await app.register(usersRoutes);
  await app.register(incidentsRoutes);
  await app.register(requestsRoutes);
  await app.register(changesRoutes);
  await app.register(attachmentsRoutes);
  await app.register(statusReportsRoutes);
  await app.register(trendsRoutes);
  await app.register(brandingRoutes);
  await app.register(weeklyReportRoutes);

  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  startEmailIngestion();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
