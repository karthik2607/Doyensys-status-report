import { FastifyInstance } from 'fastify';
import { withTenantContext, isSupportRole, orgScopeFilter } from '../lib/tenantContext';

// ===========================================================================
// TREND CHARTS — incoming vs closed tickets, week-wise and month-wise,
// broken down by severity (priority) and module (category).
//
// "Incoming" buckets by Ticket.createdAt. "Closed" buckets by
// Ticket.resolvedAt (stamped the first time a ticket reaches
// Resolved/Closed — see incidents.ts/requests.ts/changes.ts status routes).
// A ticket that's created and closed in different buckets is counted once
// in each, which is what "incoming vs closed" trend charts are meant to show.
// ===========================================================================

function startOfWeek(d: Date): Date {
  // Weeks start Monday.
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}
function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addWeeks(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 7 * 24 * 60 * 60 * 1000);
}
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
// Axis label stays short (just the week's start date, e.g. "Sep 15") so it
// never has to fight for space against its neighbors on a compact chart.
// The full "Sep 15–21" range is still returned separately as `labelFull`
// for tooltips, so nothing is lost — it's just not forced onto the axis.
function fmtWeekLabel(start: Date): string {
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtWeekLabelFull(start: Date): string {
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString('en-US', opts)}–${end.toLocaleDateString('en-US', opts)}`;
}
function fmtMonthLabel(start: Date): string {
  return start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function buildBuckets(granularity: 'week' | 'month', periods: number) {
  const now = new Date();
  const buckets: { start: Date; end: Date; label: string; labelFull: string }[] = [];
  if (granularity === 'week') {
    const thisWeekStart = startOfWeek(now);
    for (let i = periods - 1; i >= 0; i--) {
      const start = addWeeks(thisWeekStart, -i);
      const end = addWeeks(start, 1);
      buckets.push({ start, end, label: fmtWeekLabel(start), labelFull: fmtWeekLabelFull(start) });
    }
  } else {
    const thisMonthStart = startOfMonth(now);
    for (let i = periods - 1; i >= 0; i--) {
      const start = addMonths(thisMonthStart, -i);
      const end = addMonths(start, 1);
      const label = fmtMonthLabel(start);
      buckets.push({ start, end, label, labelFull: label });
    }
  }
  return buckets;
}

function bucketIndex(buckets: { start: Date; end: Date }[], date: Date): number {
  for (let i = 0; i < buckets.length; i++) {
    if (date >= buckets[i].start && date < buckets[i].end) return i;
  }
  return -1;
}

export async function trendsRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };

  // GET /api/trends?granularity=week|month&periods=8
  app.get('/api/trends', auth, async (req, reply) => {
    const ctx = req.authContext;
    const q = req.query as { granularity?: string; periods?: string; orgId?: string };
    const granularity: 'week' | 'month' = q.granularity === 'month' ? 'month' : 'week';
    const periods = Math.min(24, Math.max(2, Number(q.periods) || (granularity === 'week' ? 8 : 6)));

    const buckets = buildBuckets(granularity, periods);
    const rangeStart = buckets[0].start;

    return withTenantContext(ctx, async (tx) => {
      const orgFilter = orgScopeFilter(ctx, q.orgId);

      const tickets = await tx.ticket.findMany({
        where: {
          ...orgFilter,
          OR: [{ createdAt: { gte: rangeStart } }, { resolvedAt: { gte: rangeStart } }],
        },
        select: { type: true, priority: true, category: true, createdAt: true, resolvedAt: true },
      });

      const zeros = () => new Array(buckets.length).fill(0);
      const incoming = { total: zeros(), bySeverity: {} as Record<string, number[]>, byModule: {} as Record<string, number[]> };
      const closed = { total: zeros(), bySeverity: {} as Record<string, number[]>, byModule: {} as Record<string, number[]> };

      const ensure = (rec: Record<string, number[]>, key: string) => {
        if (!rec[key]) rec[key] = zeros();
        return rec[key];
      };

      for (const t of tickets) {
        const severity = t.priority; // P1..P4
        const module = t.category || (t.type === 'CHANGE' ? 'Change' : 'Other');

        const inIdx = bucketIndex(buckets, t.createdAt);
        if (inIdx >= 0) {
          incoming.total[inIdx]++;
          ensure(incoming.bySeverity, severity)[inIdx]++;
          ensure(incoming.byModule, module)[inIdx]++;
        }
        if (t.resolvedAt) {
          const clIdx = bucketIndex(buckets, t.resolvedAt);
          if (clIdx >= 0) {
            closed.total[clIdx]++;
            ensure(closed.bySeverity, severity)[clIdx]++;
            ensure(closed.byModule, module)[clIdx]++;
          }
        }
      }

      return {
        granularity,
        labels: buckets.map((b) => b.label),
        labelsFull: buckets.map((b) => b.labelFull),
        incoming,
        closed,
      };
    });
  });
}
