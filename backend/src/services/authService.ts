import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';

const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface LoginResult {
  user: {
    id: string;
    orgId: string;
    orgName: string;
    orgType: 'CUSTOMER' | 'DOYENSYS';
    orgLogoUrl: string | null;
    name: string;
    initials: string;
    email: string;
    role: 'CUSTOMER_ADMIN' | 'CUSTOMER_VIEWER' | 'SUPPORT_AGENT' | 'SUPPORT_MANAGER';
  };
}

/**
 * Looks up the user by email (case-insensitive), verifies the password,
 * and updates last_login_at. Does NOT issue the JWT — that's the route's
 * job (keeps token signing/expiry policy out of the service layer).
 * Returns null on any failure — callers should return a generic
 * "invalid email or password" response either way, to avoid leaking
 * which part failed.
 */
export async function attemptLogin(email: string, password: string): Promise<LoginResult | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { org: { include: { settings: { select: { logoUrl: true } } } } },
  });
  if (!user) return null;

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return {
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
  };
}
