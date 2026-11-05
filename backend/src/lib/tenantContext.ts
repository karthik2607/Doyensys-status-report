import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './prisma';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: 'CUSTOMER_ADMIN' | 'CUSTOMER_VIEWER' | 'SUPPORT_AGENT' | 'SUPPORT_MANAGER';
}

export function isSupportRole(role: AuthContext['role']): boolean {
  return role === 'SUPPORT_AGENT' || role === 'SUPPORT_MANAGER';
}

/**
 * Resolves the `orgId` filter for a list/summary query, honoring the
 * support "workspace" concept: a customer is always hard-scoped to their
 * own org; support sees everything UNLESS they've entered a specific
 * customer's workspace (passed as `?orgId=` from the frontend's active
 * workspace state), in which case they're scoped to just that org, same as
 * a customer would be. Omitting `requestedOrgId` (support's "All customers"
 * workspace) preserves the original cross-org behavior.
 */
export function orgScopeFilter(ctx: AuthContext, requestedOrgId?: string | null): { orgId?: string } {
  if (isSupportRole(ctx.role)) {
    return requestedOrgId ? { orgId: requestedOrgId } : {};
  }
  return { orgId: ctx.orgId };
}

/**
 * Runs `fn` inside a transaction with Postgres session variables set via
 * SET LOCAL, so the RLS policies in prisma/rls-policies.sql can see who's
 * asking. SET LOCAL is transaction-scoped — it cannot leak into any other
 * request, even under connection pooling.
 *
 * This is layer 1 (app-level). Every route handler MUST go through this —
 * there is no direct `prisma.*` access outside of it for tenant-scoped
 * tables. RLS (layer 2) is the backstop if this is ever bypassed by mistake,
 * not a substitute for calling this correctly.
 */
export async function withTenantContext<T>(
  ctx: AuthContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Parameterized via unsafe() because SET LOCAL doesn't accept bind
    // params — values are trusted server-side UUIDs/enum strings from the
    // verified JWT, never raw user input.
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_user_id = '${ctx.userId}'`
    );
    await tx.$executeRawUnsafe(
      `SET LOCAL app.current_org_id = '${ctx.orgId}'`
    );
    await tx.$executeRawUnsafe(
      `SET LOCAL app.role = '${ctx.role}'`
    );
    return fn(tx);
  });
}
