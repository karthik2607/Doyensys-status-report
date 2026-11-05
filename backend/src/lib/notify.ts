import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { sendMail, emailLayout, richEmail, DetailRow, EmailAccent } from '../services/emailService';

/** The detail that turns a one-line notification into a useful email.
 * `title`/`sub` still drive the in-app notification bell, which should stay
 * short; everything here is email-only, so the two can differ. Omit it and
 * the email falls back to the old single-line body. */
export interface EmailDetail {
  headline?: string;
  intro?: string;
  subject?: string;
  rows?: DetailRow[];
  description?: string | null;
  note?: { author: string; body: string } | null;
  ctaLabel?: string;
  accent?: EmailAccent;
}

interface NotifyInput {
  orgId: string;
  userId: string;
  title: string;
  sub: string;
  category: 'TICKET' | 'CHANGE' | 'REPORT' | 'SYSTEM';
  refType?: string;
  refId?: string;
  email?: EmailDetail;
}

// Runs a job just after the current tick, outside whatever Prisma
// interactive transaction called us — see notifyAndEmail for why.
function queueEmailJob(job: () => Promise<void>) {
  setImmediate(() => {
    job().catch((err) => console.error('[notify] Deferred email job failed:', err));
  });
}

/** Creates the in-app notification (inside the caller's transaction — a
 * fast, plain DB write) and schedules the email for AFTER that transaction
 * commits, using the shared non-transactional Prisma client.
 *
 * Previously the email send was awaited directly inside the caller's
 * Prisma interactive transaction. Prisma's default transaction timeout is
 * 5000ms, and a real SMTP round-trip (especially several in a row, one per
 * support agent via notifyAllSupport) regularly took longer than that —
 * so the transaction would auto-expire mid-request and the whole API call
 * (e.g. POST /api/incidents) would 500 with
 * "PrismaClientKnownRequestError P2028: Transaction already closed",
 * even though the ticket row itself had already been written earlier in
 * the same transaction. Moving the network call outside the transaction
 * fixes that: the DB work stays fast and atomic, and email sending can
 * take as long as it needs without ever failing the request. */
export async function notifyAndEmail(tx: Prisma.TransactionClient, input: NotifyInput) {
  const notification = await tx.notification.create({
    data: {
      orgId: input.orgId, userId: input.userId, title: input.title, sub: input.sub,
      category: input.category, refType: input.refType, refId: input.refId,
    },
  });

  const user = await tx.user.findUnique({ where: { id: input.userId } });
  if (!user) return;

  queueEmailJob(async () => {
    // A call site that supplied email detail gets the full branded template;
    // anything that hasn't been migrated yet still sends the plain one-liner
    // rather than silently losing its notification.
    const html = input.email
      ? richEmail({
          recipientName: user.name,
          headline: input.email.headline ?? input.title,
          intro: input.email.intro ?? input.sub,
          subject: input.email.subject,
          rows: input.email.rows,
          description: input.email.description,
          note: input.email.note,
          ctaLabel: input.email.ctaLabel,
          accent: input.email.accent,
        })
      : emailLayout(user.name, `<p>${input.sub}</p>`);

    await sendMail(user.email, input.title, html);
    await prisma.notification.update({
      where: { id: notification.id },
      data: { emailSentAt: new Date() },
    });
  });
}

/** Notifies every support user (SUPPORT_AGENT/SUPPORT_MANAGER, system-wide —
 * support staff isn't split per customer org) — used for "new ticket
 * created" and "ticket assigned" so the whole team always hears about it.
 * Pass `excludeUserId` to skip someone who's already getting a separate,
 * more specific message (e.g. the agent a ticket was just assigned to,
 * who gets their own "assigned to you" email instead of the team-wide one). */
export async function notifyAllSupport(
  tx: Prisma.TransactionClient,
  input: Omit<NotifyInput, 'userId' | 'orgId'> & { orgId: string },
  opts?: { excludeUserId?: string },
) {
  const supportUsers = await tx.user.findMany({
    where: {
      role: { in: ['SUPPORT_AGENT', 'SUPPORT_MANAGER'] },
      ...(opts?.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
    },
  });
  for (const u of supportUsers) {
    await notifyAndEmail(tx, { ...input, userId: u.id });
  }
}
