import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// ===========================================================================
// LIST ALL PORTAL USERS — who exists, in which org, with what role, and
// whether they've ever actually signed in.
//
// Read-only. Safe to run any time, on any environment.
//
// Usage:  npx tsx scripts/listUsers.ts     (or: npm run list-users)
//         npm run list-users -- --support  (support accounts only)
//         npm run list-users -- --customer (customer accounts only)
// ===========================================================================

const prisma = new PrismaClient();

const SUPPORT_ROLES = ['SUPPORT_AGENT', 'SUPPORT_MANAGER'];

function pad(s: string, n: number) {
  return String(s ?? '').padEnd(n).slice(0, n);
}

async function main() {
  const args = process.argv.slice(2);
  const onlySupport = args.includes('--support');
  const onlyCustomer = args.includes('--customer');

  const users = await prisma.user.findMany({
    include: { org: { select: { name: true, type: true } } },
    orderBy: [{ org: { type: 'asc' } }, { org: { name: 'asc' } }, { role: 'asc' }, { name: 'asc' }],
  });

  const filtered = users.filter((u: any) => {
    const isSupport = SUPPORT_ROLES.includes(u.role);
    if (onlySupport) return isSupport;
    if (onlyCustomer) return !isSupport;
    return true;
  });

  if (filtered.length === 0) {
    console.log('\nNo users match.\n');
    await prisma.$disconnect();
    return;
  }

  // Group by org so each customer's team reads as a block rather than one
  // long undifferentiated list.
  const byOrg = new Map<string, any[]>();
  for (const u of filtered) {
    const key = `${u.org.type === 'DOYENSYS' ? '0' : '1'}|${u.org.name}`;
    if (!byOrg.has(key)) byOrg.set(key, []);
    byOrg.get(key)!.push(u);
  }

  console.log('');
  for (const key of [...byOrg.keys()].sort()) {
    const rows = byOrg.get(key)!;
    const orgName = key.split('|')[1];
    const orgType = rows[0].org.type === 'DOYENSYS' ? 'Doyensys (support)' : 'Customer';
    console.log(`${orgName}  —  ${orgType}  (${rows.length} user${rows.length !== 1 ? 's' : ''})`);
    console.log('  ' + pad('NAME', 24) + pad('EMAIL', 34) + pad('ROLE', 18) + 'LAST LOGIN');
    console.log('  ' + '-'.repeat(88));
    for (const u of rows) {
      const last = u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 10) : 'never';
      console.log('  ' + pad(u.name, 24) + pad(u.email, 34) + pad(u.role, 18) + last);
    }
    console.log('');
  }

  const supportCount = users.filter((u: any) => SUPPORT_ROLES.includes(u.role)).length;
  const customerCount = users.length - supportCount;
  const customerOrgs = new Set(users.filter((u: any) => u.org.type === 'CUSTOMER').map((u: any) => u.org.name));

  console.log('--------------------------------------------------------');
  console.log(`  Support users:   ${supportCount}`);
  console.log(`  Customer users:  ${customerCount}  across ${customerOrgs.size} customer org(s)`);
  console.log(`  Total:           ${users.length}`);
  console.log('--------------------------------------------------------\n');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
