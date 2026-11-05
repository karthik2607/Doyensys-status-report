import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/authService';

// ===========================================================================
// ONBOARD A NEW CUSTOMER TENANT
//
// Despite the name, this script is generic — it defaults to Petmate but every
// value is a prompt you can override, so use it for customer #3, #4, #5 too.
// It creates, in one pass:
//
//   • the customer Org (with the cosmetic login-page email domain + logo URL)
//   • their OrgSettings (logo, support contacts)
//   • their user account(s)
//   • optionally, a starter project and a few sample tickets so the
//     workspace has something in it when you demo or hand it over
//
// It is idempotent: re-running it finds the existing org by name and updates
// it rather than creating a duplicate, and it skips users whose email
// already exists. Safe to run again after a mistake.
//
// Usage:  npx tsx scripts/setupPetmate.ts     (or: npm run setup-customer)
// ===========================================================================

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: stdin, output: stdout });

// Every prompt shows its default in brackets — press Enter to accept it.
async function ask(question: string, fallback = ''): Promise<string> {
  const shown = fallback ? `${question} [${fallback}]: ` : `${question}: `;
  const answer = (await rl.question(shown)).trim();
  return answer || fallback;
}
async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} (y/n)`, defaultYes ? 'y' : 'n')).toLowerCase();
  return answer.startsWith('y');
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomFillSync(new Uint32Array(12)))
    .map((n) => chars[n % chars.length])
    .join('');
}
function initialsOf(name: string): string {
  return name.trim().split(/\s+/).map((p) => p[0]?.toUpperCase() ?? '').slice(0, 2).join('');
}

async function main() {
  console.log('\n=== Doyensys Portal — Onboard a Customer Tenant ===');
  console.log('Press Enter at any prompt to accept the default shown in brackets.\n');

  // -------------------------------------------------------------------- org
  const orgName = await ask('Customer name', 'Petmate');
  // Cosmetic only — decides whose logo previews on the login page as someone
  // types their email. Never used to grant access; that is always the user's
  // own orgId. See the comment on Org.emailDomain in schema.prisma.
  const emailDomain = (await ask('Email domain (login-page branding only)', 'petmate.com')).toLowerCase();
  // The API serves logos itself (see src/routes/branding.ts), so branding
  // doesn't depend on whatever is hosting the portal HTML. Put the image in
  // LOGOS_DIR (default /opt/doyensys/logos) and point this at the API.
  const apiBase = (process.env.PUBLIC_API_URL || 'http://129.213.120.206:4000/api').replace(/\/$/, '');
  const defaultLogoUrl = `${apiBase}/logos/petmate.png`;
  const logoUrl = await ask('Logo URL', defaultLogoUrl);

  let org = await prisma.org.findFirst({ where: { name: orgName, type: 'CUSTOMER' } });
  if (org) {
    org = await prisma.org.update({ where: { id: org.id }, data: { emailDomain } });
    console.log(`\n↻ Org "${orgName}" already existed (${org.id}) — updated its branding.`);
  } else {
    org = await prisma.org.create({ data: { name: orgName, type: 'CUSTOMER', emailDomain } });
    console.log(`\n✅ Created org "${orgName}" (${org.id}).`);
  }

  await prisma.orgSettings.upsert({
    where: { orgId: org.id },
    create: {
      orgId: org.id,
      logoUrl,
      supportEmail: 'support@doyensys.com',
      supportPhone: '+1 (800) 555-0182',
      accountManager: 'Narasimha Rao Karanam',
      emergencySupport: '+1 (800) 555-0199',
    },
    update: { logoUrl },
  });
  console.log(`✅ Branding set — domain @${emailDomain}, logo ${logoUrl}`);

  // ------------------------------------------------------------------ users
  console.log('\n--- User accounts ---');
  console.log('Add the people who will sign in for this customer. Blank name = done.\n');

  const created: { name: string; email: string; role: string; password: string }[] = [];
  let first = true;
  while (true) {
    const name = await ask(first ? 'Full name' : 'Full name (blank to finish)', first ? 'Petmate Admin' : '');
    if (!name) break;
    const defaultEmail = first
      ? `admin@${emailDomain}`
      : `${name.toLowerCase().replace(/\s+/g, '.')}@${emailDomain}`;
    const email = (await ask('  Email', defaultEmail)).toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`  ⚠ ${email} already exists — skipped.\n`);
      first = false;
      continue;
    }

    const roleAnswer = (await ask('  Role — (a)dmin or (v)iewer', 'a')).toLowerCase();
    const role = roleAnswer.startsWith('v') ? 'CUSTOMER_VIEWER' : 'CUSTOMER_ADMIN';

    let password = await ask('  Password (blank to auto-generate)', '');
    if (!password) password = generatePassword();

    await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), name, initials: initialsOf(name), role, orgId: org.id },
    });
    created.push({ name, email, role, password });
    console.log(`  ✅ ${name} <${email}> — ${role}\n`);
    first = false;
  }

  // ------------------------------------------------------------ sample data
  // An empty workspace is hard to demo and hard to sanity-check — a handful
  // of tickets proves isolation is working the moment you switch into it.
  const wantSamples = await askYesNo('\nSeed a starter project and sample tickets for this customer?', true);

  if (wantSamples) {
    const requestor = await prisma.user.findFirst({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } });
    if (!requestor) {
      console.log('⚠ No user exists for this org, so sample tickets were skipped (a ticket needs a requestor).');
    } else {
      const existingProject = await prisma.project.findFirst({ where: { orgId: org.id } });
      if (existingProject) {
        console.log(`↻ Project "${existingProject.name}" already exists — skipping project creation.`);
      } else {
        const project = await prisma.project.create({
          data: {
            orgId: org.id,
            name: `${orgName} Oracle Support Engagement`,
            pm: 'Sarah Chen',
            health: 'ON_TRACK',
            progress: 35,
            phase: 'Steady State Support',
            openRiskCount: 0,
            openIssueCount: 0,
          },
        });
        await prisma.projectTask.createMany({
          data: [
            { projectId: project.id, phase: 'Onboarding', taskName: 'Environment access handover', owner: 'Doyensys', percentComplete: 1, sortOrder: 1, endDate: new Date(Date.now() - 7 * 864e5) },
            { projectId: project.id, phase: 'Onboarding', taskName: 'Runbook walkthrough', owner: 'Doyensys', percentComplete: 0.6, sortOrder: 2, endDate: new Date(Date.now() + 5 * 864e5) },
            { projectId: project.id, phase: 'Steady State Support', taskName: 'Monthly performance review', owner: 'Doyensys', percentComplete: 0, sortOrder: 3, endDate: new Date(Date.now() + 18 * 864e5) },
          ],
        });
        console.log(`✅ Created project "${project.name}" with 3 plan tasks.`);
      }

      const existingTickets = await prisma.ticket.count({ where: { orgId: org.id } });
      if (existingTickets > 0) {
        console.log(`↻ ${orgName} already has ${existingTickets} ticket(s) — skipping sample tickets.`);
      } else {
        const slaHours: Record<string, number> = { P1: 4, P2: 8, P3: 24, P4: 72 };
        const mk = (type: 'INCIDENT' | 'REQUEST', title: string, description: string, priority: 'P1'|'P2'|'P3'|'P4', status: any, category: string, ageDays: number) => {
          const created = new Date(Date.now() - ageDays * 864e5);
          const hours = slaHours[priority];
          return {
            orgId: org!.id, type, title, description, priority, status, category,
            requestorId: requestor.id,
            createdAt: created,
            responseSlaDueAt: new Date(created.getTime() + hours * 36e5 * 0.25),
            resolutionSlaDueAt: new Date(created.getTime() + hours * 36e5),
            resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? new Date(created.getTime() + hours * 36e5 * 0.6) : null,
          };
        };

        const samples = [
          mk('INCIDENT', 'Order sync job failing overnight', 'The nightly order synchronization job has failed for the last two runs with a timeout against the warehouse endpoint.', 'P2', 'IN_PROGRESS', 'Application', 3),
          mk('INCIDENT', 'Invoice PDF export returns a blank file', 'Exporting invoices to PDF from the billing screen downloads a 0 KB file for any date range.', 'P3', 'RAISED', 'Application', 1),
          mk('REQUEST', 'New user access for warehouse supervisor', 'Please provision portal and ERP read access for our incoming warehouse supervisor starting next Monday.', 'P3', 'RESPONDED', 'Access', 5),
          mk('REQUEST', 'Add Canada region to inventory dashboard', 'Requesting the inventory dashboard be extended to include the Canadian distribution centre alongside the US regions.', 'P4', 'RAISED', 'Enhancement', 2),
        ];

        for (const data of samples) {
          const ticket = await prisma.ticket.create({ data });
          await prisma.ticketEvent.create({ data: { ticketId: ticket.id, eventText: 'Ticket created' } });
        }
        console.log(`✅ Created ${samples.length} sample tickets (2 incidents, 2 requests).`);
      }
    }
  }

  // ---------------------------------------------------------------- summary
  console.log('\n========================================================');
  console.log(`  ${orgName} is now live in the portal.`);
  console.log('========================================================');
  if (created.length) {
    console.log('\nSign-in credentials — share these securely, they are not shown again:\n');
    created.forEach((u) => {
      console.log(`  ${u.name}`);
      console.log(`    email:    ${u.email}`);
      console.log(`    password: ${u.password}`);
      console.log(`    role:     ${u.role}\n`);
    });
  } else {
    console.log('\nNo new user accounts were created in this run.');
  }
  console.log('Next: make sure the logo file is actually reachable at');
  console.log(`  ${logoUrl}`);
  console.log('The API serves logos out of LOGOS_DIR (default /opt/doyensys/logos), so:');
  console.log('  sudo mkdir -p /opt/doyensys/logos');
  console.log('  sudo cp petmate-logo.png /opt/doyensys/logos/petmate.png');
  console.log(`  curl -I ${logoUrl}      # expect 200\n`);

  await prisma.$disconnect();
  rl.close();
}

main().catch(async (err) => {
  console.error('\n❌ Setup failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
