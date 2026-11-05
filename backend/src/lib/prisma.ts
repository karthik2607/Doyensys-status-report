import { PrismaClient } from '@prisma/client';

// Single shared instance across the app — Prisma manages its own connection
// pool internally, so we don't want one PrismaClient per request.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
