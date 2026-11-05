import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import { prisma } from '../lib/prisma';
import { notifyAllSupport } from '../lib/notify';
import { withTenantContext } from '../lib/tenantContext';

/**
 * Polls a mailbox (e.g. support@moregroup-inc.com) for unread messages and
 * turns each one into an incident, attributed to the sender if their email
 * matches an existing customer account.
 *
 * Deliberately conservative: if the sender's email doesn't match any known
 * customer user, we do NOT auto-create a ticket (wrong tenant/org
 * attribution would be worse than no ticket at all) — instead we notify
 * support so a human can follow up and, if needed, create the account or
 * file the ticket manually.
 */

const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER || process.env.SMTP_USER;
const IMAP_PASS = process.env.IMAP_PASS || process.env.SMTP_PASS;
const POLL_INTERVAL_MS = Number(process.env.EMAIL_INGESTION_POLL_SECONDS || 60) * 1000;

function extractSenderEmail(fromText: string | undefined): string | null {
  if (!fromText) return null;
  const match = fromText.match(/<([^>]+)>/);
  return (match ? match[1] : fromText).trim().toLowerCase();
}

async function processInbox() {
  if (!IMAP_USER || !IMAP_PASS) {
    console.warn('[email-ingestion] IMAP_USER/IMAP_PASS (or SMTP_USER/SMTP_PASS) not set — skipping poll.');
    return;
  }

  let connection: imaps.ImapSimple | null = null;
  try {
    connection = await imaps.connect({
      imap: {
        user: IMAP_USER,
        password: IMAP_PASS,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { servername: IMAP_HOST },
      },
    });

    await connection.openBox('INBOX');

    const results = await connection.search(['UNSEEN'], {
      bodies: [''],
      markSeen: false, // we mark seen manually per-message, only after successful processing
    });

    if (results.length === 0) return;
    console.log(`[email-ingestion] ${results.length} unread message(s) found.`);

    for (const item of results) {
      const raw = item.parts.find((p) => p.which === '')?.body;
      if (!raw) continue;

      try {
        const parsed = await simpleParser(raw);
        const senderEmail = extractSenderEmail(parsed.from?.text);
        const subject = parsed.subject || '(No subject)';
        const bodyText = (parsed.text || parsed.html || '').toString().trim().slice(0, 5000);

        if (!senderEmail) {
          console.warn('[email-ingestion] Could not parse sender address — skipping.');
          continue;
        }

        // This runs outside any HTTP request, so there's no logged-in user
        // to derive a tenant context from. We authorize it as a system
        // actor with SUPPORT_AGENT-equivalent access — every RLS policy in
        // this app grants broad access to support roles via `app_is_support()`,
        // which is exactly the right level for a backend process creating
        // tickets on behalf of any customer. Without setting this, Postgres
        // RLS would silently reject every insert (no app.role means every
        // `org_id = app_current_org_id()` check evaluates to NULL/false).
        await withTenantContext(
          { userId: 'system-email-ingestion', orgId: 'system', role: 'SUPPORT_AGENT' },
          async (tx) => {
            const user = await tx.user.findUnique({ where: { email: senderEmail } });

            if (user && (user.role === 'CUSTOMER_ADMIN' || user.role === 'CUSTOMER_VIEWER')) {
              const ticket = await tx.ticket.create({
                data: {
                  orgId: user.orgId, type: 'INCIDENT', title: subject.slice(0, 200),
                  description: bodyText || '(No message body)', priority: 'P3',
                  category: 'Email', status: 'RAISED', requestorId: user.id,
                  responseSlaDueAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
                  resolutionSlaDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
                },
              });
              await tx.ticketEvent.create({
                data: { ticketId: ticket.id, eventText: `Ticket created automatically from an email sent by ${user.name}` },
              });
              await notifyAllSupport(tx, {
                orgId: user.orgId, title: 'New incident created via email',
                sub: subject, category: 'TICKET', refType: 'ticket', refId: ticket.id,
              });
              console.log(`[email-ingestion] Created incident ${ticket.id} from email by ${senderEmail}.`);
            } else {
              console.warn(`[email-ingestion] No matching customer account for ${senderEmail} — notifying support instead of auto-creating a ticket.`);
              const supportUsers = await tx.user.findMany({ where: { role: { in: ['SUPPORT_AGENT', 'SUPPORT_MANAGER'] } } });
              for (const s of supportUsers) {
                await tx.notification.create({
                  data: {
                    orgId: s.orgId, userId: s.id, title: 'Email from an unrecognized sender',
                    sub: `${senderEmail}: ${subject}`, category: 'SYSTEM',
                  },
                });
              }
            }
          }
        );

        await connection.addFlags(item.attributes.uid, '\\Seen');
      } catch (err) {
        console.error('[email-ingestion] Failed to process a message (leaving it unread):', err);
      }
    }
  } catch (err) {
    console.error('[email-ingestion] IMAP poll failed:', err);
  } finally {
    if (connection) connection.end();
  }
}

let pollHandle: ReturnType<typeof setInterval> | null = null;

export function startEmailIngestion() {
  if (process.env.EMAIL_INGESTION_ENABLED !== 'true') {
    console.log('[email-ingestion] Disabled (EMAIL_INGESTION_ENABLED != \'true\') — not polling.');
    return;
  }
  console.log(`[email-ingestion] Starting — polling ${IMAP_USER} every ${POLL_INTERVAL_MS / 1000}s.`);
  processInbox(); // run once immediately, then on the interval
  pollHandle = setInterval(processInbox, POLL_INTERVAL_MS);
}

export function stopEmailIngestion() {
  if (pollHandle) clearInterval(pollHandle);
}
