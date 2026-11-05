import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';

// Sets or updates an existing customer org's login-page branding: the
// email domain used to preview their logo as someone types their email
// (cosmetic only — see the comment on Org.emailDomain in schema.prisma),
// and the logo image URL itself.
//
// Usage: npx tsx scripts/setOrgBranding.ts
//   (or: npm run set-org-branding)

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: stdin, output: stdout });

async function main() {
  console.log('=== Doyensys Portal — Set Customer Org Branding ===\n');

  const orgs = await prisma.org.findMany({
    where: { type: 'CUSTOMER' },
    orderBy: { name: 'asc' },
    include: { settings: true },
  });
  if (orgs.length === 0) {
    console.log('No customer orgs exist yet — create one first with `npm run create-account`.');
    process.exit(0);
  }

  console.log('Customer orgs:');
  orgs.forEach((o, i) => {
    console.log(`  ${i + 1}. ${o.name}  (domain: ${o.emailDomain || '—'}, logo: ${o.settings?.logoUrl ? 'set' : '—'})`);
  });

  const choice = Number((await rl.question('\nSelect org number: ')).trim()) - 1;
  const org = orgs[choice];
  if (!org) {
    console.error('Invalid selection. Aborting.');
    process.exit(1);
  }

  const emailDomain = (await rl.question(
    `Email domain for login-page branding [current: ${org.emailDomain || '—'}] (blank to leave unchanged, type "clear" to remove): `
  )).trim().toLowerCase();
  const logoUrl = (await rl.question(
    `Logo URL [current: ${org.settings?.logoUrl || '—'}] (blank to leave unchanged, type "clear" to remove): `
  )).trim();

  const data: { emailDomain?: string | null } = {};
  if (emailDomain === 'clear') data.emailDomain = null;
  else if (emailDomain) data.emailDomain = emailDomain;
  if (Object.keys(data).length) {
    await prisma.org.update({ where: { id: org.id }, data });
  }

  if (logoUrl === 'clear') {
    await prisma.orgSettings.upsert({ where: { orgId: org.id }, create: { orgId: org.id, logoUrl: null }, update: { logoUrl: null } });
  } else if (logoUrl) {
    await prisma.orgSettings.upsert({ where: { orgId: org.id }, create: { orgId: org.id, logoUrl }, update: { logoUrl } });
  }

  const updated = await prisma.org.findUnique({ where: { id: org.id }, include: { settings: true } });
  console.log(`\n✅ ${updated!.name} — domain: ${updated!.emailDomain || '—'}, logo: ${updated!.settings?.logoUrl || '—'}`);

  await prisma.$disconnect();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
