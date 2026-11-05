import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/authService';
import { sendMail, richEmail } from '../src/services/emailService';

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: stdin, output: stdout });

function generatePassword(): string {
  // 12 random chars from a readable set — good enough for a one-time
  // provisioning password the person changes on first real use.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomFillSync(new Uint32Array(12)))
    .map((n) => chars[n % chars.length])
    .join('');
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map((p) => p[0]?.toUpperCase() ?? '').slice(0, 2).join('');
}

async function main() {
  console.log('=== Doyensys Portal — Create Account ===\n');

  const accountType = (await rl.question('Account type — (c)ustomer or (s)upport? ')).trim().toLowerCase();
  const isCustomer = accountType.startsWith('c');

  const name = (await rl.question('Full name: ')).trim();
  const email = (await rl.question('Email: ')).trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`\nA user with email ${email} already exists (id: ${existing.id}). Aborting.`);
    process.exit(1);
  }

  let orgId: string;
  let role: 'CUSTOMER_ADMIN' | 'CUSTOMER_VIEWER' | 'SUPPORT_AGENT' | 'SUPPORT_MANAGER';

  if (isCustomer) {
    const orgs = await prisma.org.findMany({ where: { type: 'CUSTOMER' }, orderBy: { name: 'asc' } });
    console.log('\nExisting customer orgs:');
    orgs.forEach((o, i) => console.log(`  ${i + 1}. ${o.name}`));
    console.log(`  ${orgs.length + 1}. Create a new customer org`);

    const orgChoice = (await rl.question('\nSelect org number: ')).trim();
    const orgIdx = Number(orgChoice) - 1;

    if (orgIdx === orgs.length) {
      const newOrgName = (await rl.question('New org name: ')).trim();
      // Cosmetic only — see the comment on Org.emailDomain in schema.prisma.
      // Used to show this customer's logo on the login page as their users
      // type their email; never used to grant access.
      const emailDomain = (await rl.question('Email domain for login-page branding, e.g. petmate.com (blank to skip): ')).trim().toLowerCase() || null;
      const logoUrl = (await rl.question('Logo URL (a link to their logo image, blank to skip): ')).trim() || null;
      const newOrg = await prisma.org.create({ data: { name: newOrgName, type: 'CUSTOMER', emailDomain } });
      if (logoUrl) {
        await prisma.orgSettings.upsert({
          where: { orgId: newOrg.id },
          create: { orgId: newOrg.id, logoUrl },
          update: { logoUrl },
        });
      }
      orgId = newOrg.id;
      console.log(`Created org "${newOrgName}" (${newOrg.id})${emailDomain ? `, branded for @${emailDomain}` : ''}${logoUrl ? ' with a logo' : ''}.`);
    } else if (orgs[orgIdx]) {
      orgId = orgs[orgIdx].id;
    } else {
      console.error('Invalid selection. Aborting.');
      process.exit(1);
    }

    const roleChoice = (await rl.question('Role — (a)dmin or (v)iewer? [a]: ')).trim().toLowerCase() || 'a';
    role = roleChoice.startsWith('v') ? 'CUSTOMER_VIEWER' : 'CUSTOMER_ADMIN';
  } else {
    let doyensysOrg = await prisma.org.findFirst({ where: { type: 'DOYENSYS' } });
    if (!doyensysOrg) {
      doyensysOrg = await prisma.org.create({ data: { name: 'Doyensys', type: 'DOYENSYS' } });
      console.log('Created the Doyensys internal org.');
    }
    orgId = doyensysOrg.id;

    const roleChoice = (await rl.question('Role — (a)gent or (m)anager? [a]: ')).trim().toLowerCase() || 'a';
    role = roleChoice.startsWith('m') ? 'SUPPORT_MANAGER' : 'SUPPORT_AGENT';
  }

  let password = (await rl.question('\nPassword (leave blank to auto-generate): ')).trim();
  const wasGenerated = !password;
  if (!password) password = generatePassword();

  const sendWelcome = (await rl.question('Send a welcome email with these credentials? (y/n) [y]: ')).trim().toLowerCase() !== 'n';

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, initials: initials(name), role, orgId },
  });

  console.log('\n✅ Account created:');
  console.log(`   Name:     ${user.name}`);
  console.log(`   Email:    ${user.email}`);
  console.log(`   Role:     ${user.role}`);
  console.log(`   Org ID:   ${user.orgId}`);
  console.log(`   Password: ${password}${wasGenerated ? '  (auto-generated — share this securely, it will not be shown again)' : ''}`);

  if (sendWelcome) {
    // Deliberately does NOT say "temporary password" or ask them to change
    // it on first login: there is no self-service password change in the
    // portal yet, so telling people to do something they can't do just
    // generates support requests. Reinstate that wording once a
    // change-password screen exists.
    const portalUrl = (process.env.PORTAL_URL || '').replace(/\/+$/, '');
    const isCustomerAccount = user.role === 'CUSTOMER_ADMIN' || user.role === 'CUSTOMER_VIEWER';
    await sendMail(
      user.email,
      'Your Doyensys Portal account',
      richEmail({
        recipientName: user.name,
        headline: 'Your portal account is ready',
        intro: isCustomerAccount
          ? 'You now have access to the Doyensys Customer Portal — your single window into the engagement. Raise incidents and service requests, track their progress, approve change requests, and read the status reports as they are published.'
          : 'You now have access to the Doyensys Customer Portal. You can work tickets across all customers, assign them to yourself or your colleagues, and publish status reports.',
        rows: [
          { label: 'Sign-in email', value: user.email },
          { label: 'Password', value: password },
          { label: 'Role', value: user.role.replace(/_/g, ' ') },
        ],
        ctaLabel: portalUrl ? 'Sign in to the portal' : undefined,
        accent: 'red',
      }),
    );
    if (!portalUrl) {
      console.log('\n⚠ PORTAL_URL is not set in .env, so the welcome email has no sign-in button.');
      console.log('  Add PORTAL_URL="http://<your-portal-address>" and re-send to include it.');
    }
    console.log('\n📧 Welcome email sent (or logged as skipped if SMTP isn\'t configured — check the console output above).');
  }

  await prisma.$disconnect();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
