import { Prisma } from '@prisma/client';
import { EmailDetail } from './notify';
import { EmailAccent } from '../services/emailService';

// ===========================================================================
// TICKET EMAIL DETAIL
//
// Builds the full detail block for a notification email straight from the
// ticket, so every call site stays a couple of lines instead of assembling
// the same field list by hand 29 times over. One read inside the caller's
// transaction; the email itself is still sent after that commits.
// ===========================================================================

export function ticketCode(type: string, number: number): string {
  const prefix = type === 'INCIDENT' ? 'INC' : type === 'REQUEST' ? 'REQ' : 'CHG';
  return `${prefix}${String(number).padStart(6, '0')}`;
}

const STATUS_LABELS: Record<string, string> = {
  RAISED: 'Raised',
  RESPONDED: 'Responded',
  IN_PROGRESS: 'In Progress',
  WAITING_ON_CUSTOMER: 'Waiting on Customer',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const STAGE_LABELS: Record<string, string> = {
  RAISED: 'Raised',
  CUSTOMER_APPROVAL: 'Customer Approval',
  DEV: 'Development',
  DEV_REVIEW: 'Development Review',
  TEST: 'Testing',
  TEST_REVIEW: 'Test Review',
  PROD: 'Production Deployment',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

const RISK_LABELS: Record<string, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };

const TYPE_LABELS: Record<string, string> = {
  INCIDENT: 'Incident',
  REQUEST: 'Service Request',
  CHANGE: 'Change Request',
};

function fmtDateTime(d: Date | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toLocaleString('en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/** How long until (or how long since) an SLA deadline, in plain words —
 * more useful in an inbox than a bare timestamp. */
function duePhrase(due: Date | null | undefined): string | null {
  if (!due) return null;
  const ms = new Date(due).getTime() - Date.now();
  const hours = Math.round(Math.abs(ms) / 36e5);
  const when = hours < 1
    ? 'under an hour'
    : hours < 48
      ? `${hours} hour${hours === 1 ? '' : 's'}`
      : `${Math.round(hours / 24)} days`;
  const stamp = fmtDateTime(due);
  return ms >= 0 ? `${stamp} (in ${when})` : `${stamp} — OVERDUE by ${when}`;
}

export interface TicketEmailOptions {
  headline: string;
  intro: string;
  accent?: EmailAccent;
  ctaLabel?: string;
  note?: { author: string; body: string } | null;
  /** Set false for status-change emails, where the original description is
   * noise compared to the update itself. */
  includeDescription?: boolean;
  /** Extra rows specific to this event, e.g. "Changed from / Changed to". */
  extraRows?: { label: string; value: string | null | undefined; badge?: boolean }[];
}

/**
 * Loads the ticket and returns a populated EmailDetail. Returns a minimal
 * detail (rather than throwing) if the ticket can't be read, so a failure
 * here can never stop a notification going out.
 */
export async function ticketEmailDetail(
  tx: Prisma.TransactionClient,
  ticketId: string,
  opts: TicketEmailOptions,
): Promise<EmailDetail> {
  const base: EmailDetail = {
    headline: opts.headline,
    intro: opts.intro,
    accent: opts.accent,
    ctaLabel: opts.ctaLabel,
    note: opts.note ?? null,
  };

  try {
    const t = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: {
        org: { select: { name: true } },
        requestor: { select: { name: true, email: true } },
        assignee: { select: { name: true, email: true } },
        changeDetail: { select: { stage: true, risk: true } },
      },
    });
    if (!t) return base;

    const code = ticketCode(t.type, t.number);
    const isChange = t.type === 'CHANGE';

    const rows: { label: string; value: string | null | undefined; badge?: boolean }[] = [
      { label: 'Type', value: TYPE_LABELS[t.type] ?? t.type },
      { label: 'Priority', value: t.priority, badge: true },
    ];

    if (isChange && t.changeDetail) {
      rows.push({ label: 'Stage', value: STAGE_LABELS[t.changeDetail.stage] ?? t.changeDetail.stage, badge: true });
      rows.push({ label: 'Risk', value: RISK_LABELS[t.changeDetail.risk] ?? t.changeDetail.risk });
    } else if (t.status) {
      rows.push({ label: 'Status', value: STATUS_LABELS[t.status] ?? t.status, badge: true });
    }

    if (t.category) rows.push({ label: 'Category', value: t.category });
    rows.push({ label: 'Customer', value: t.org?.name });
    rows.push({ label: 'Raised by', value: t.requestor?.name });
    rows.push({ label: 'Assigned to', value: t.assignee?.name ?? 'Unassigned' });
    rows.push({ label: 'Raised on', value: fmtDateTime(t.createdAt) });

    // Only surface SLA deadlines while they still matter — on a resolved or
    // closed ticket they're just noise.
    const stillOpen = isChange
      ? !['RESOLVED', 'CLOSED'].includes(t.changeDetail?.stage ?? '')
      : !['RESOLVED', 'CLOSED'].includes(t.status ?? '');
    if (stillOpen) {
      rows.push({ label: 'Response due', value: duePhrase(t.responseSlaDueAt) });
      rows.push({ label: 'Resolution due', value: duePhrase(t.resolutionSlaDueAt) });
    } else if (t.resolvedAt) {
      rows.push({ label: 'Resolved on', value: fmtDateTime(t.resolvedAt) });
    }

    if (opts.extraRows?.length) rows.push(...opts.extraRows);

    return {
      ...base,
      subject: `${code} — ${t.title}`,
      rows,
      description: opts.includeDescription === false ? null : t.description,
    };
  } catch (err) {
    console.error('[ticketEmail] Could not build detail for', ticketId, err);
    return base;
  }
}
