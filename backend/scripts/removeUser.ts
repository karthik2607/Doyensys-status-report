import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';

// ===========================================================================
// REMOVE A PORTAL USER — safely.
//
// Deleting a user is not always possible, and that is deliberate. Several
// tables point at users with NOT NULL foreign keys, because a ticket must
// have a requestor and a note must have an author — history would be
// corrupted if those could dangle. So this script does three things:
//
//   1. Shows exactly what the account is attached to before anything happens.
//   2. Clears what can safely be cleared:
//        • ticket assignments        -> unassigned (assignee is nullable)
//        • audit-log actor references -> null      (actor is nullable)
//        • their own notifications    -> deleted   (disposable, personal)
//   3. Refuses to delete if real history remains (tickets they raised, notes
//      they wrote, reports they authored, files they uploaded), and tells you
//      what is blocking it. That content has to be reassigned or removed
//      first — a deliberate decision, not something a script should guess at.
//
// Usage:  npx tsx scripts/removeUser.ts    (or: npm run remove-user)
// ===========================================================================

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: stdin, output: stdout });

async function main() {
  console.log('\n=== Doyensys Portal — Remove a User ===\n');

  const users = await prisma.user.findMany({
    include: { org: { select: { name: true, type: true } } },
    orderBy: [{ org: { name: 'asc' } }, { name: 'asc' }],
  });

  if (users.length === 0) {
    console.log('No users exist.');
    await prisma.$disconnect();
    rl.close();
    return;
  }

  users.forEach((u: any, i: number) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${u.name}  <${u.email}>  — ${u.role} @ ${u.org.name}`);
  });

  const choice = Number((await rl.question('\nSelect user number to remove: ')).trim()) - 1;
  const user = users[choice];
  if (!user) {
    console.error('Invalid selection. Aborting.');
    process.exit(1);
  }

  // ------------------------------------------------------- what's attached
  const [
    ticketsRequested, ticketsAssigned, notes, attachments,
    changeHistory, reportsAuthored, reportUploads, notifications, auditEntries,
  ] = await Promise.all([
    prisma.ticket.count({ where: { requestorId: user.id } }),
    prisma.ticket.count({ where: { assigneeId: user.id } }),
    prisma.ticketNote.count({ where: { authorId: user.id } }),
    prisma.ticketAttachment.count({ where: { uploadedById: user.id } }),
    prisma.changeHistory.count({ where: { byId: user.id } }),
    prisma.statusReport.count({ where: { authorId: user.id } }),
    prisma.statusReportUpload.count({ where: { uploadedById: user.id } }),
    prisma.notification.count({ where: { userId: user.id } }),
    prisma.auditLog.count({ where: { actorId: user.id } }),
  ]);

  console.log(`\n${user.name} <${user.email}> is attached to:`);
  console.log(`  tickets raised:        ${ticketsRequested}   ${ticketsRequested ? '<- blocks deletion' : ''}`);
  console.log(`  notes written:         ${notes}   ${notes ? '<- blocks deletion' : ''}`);
  console.log(`  files uploaded:        ${attachments}   ${attachments ? '<- blocks deletion' : ''}`);
  console.log(`  change-history entries:${changeHistory}   ${changeHistory ? '<- blocks deletion' : ''}`);
  console.log(`  status reports authored:${reportsAuthored}  ${reportsAuthored ? '<- blocks deletion' : ''}`);
  console.log(`  report files uploaded: ${reportUploads}   ${reportUploads ? '<- blocks deletion' : ''}`);
  console.log(`  tickets assigned:      ${ticketsAssigned}   (will be unassigned)`);
  console.log(`  notifications:         ${notifications}   (will be deleted)`);
  console.log(`  audit-log entries:     ${auditEntries}   (actor will be cleared)`);

  const blockers = ticketsRequested + notes + attachments + changeHistory + reportsAuthored + reportUploads;

  if (blockers > 0) {
    console.log('\n❌ This account cannot be deleted — it owns history that would be orphaned.');
    console.log('   Tickets, notes, reports and uploads must keep a valid owner.\n');
    console.log('   Your options:');
    console.log('     • Leave the account in place and just change its password so nobody can sign in.');
    console.log('     • Reassign or delete the content above first, then re-run this script.');
    console.log('\n   Nothing was changed.\n');
    await prisma.$disconnect();
    rl.close();
    return;
  }

  console.log('\nThis account owns no ticket or report history, so it can be removed cleanly.');
  const typed = (await rl.question(`Type the email to confirm deletion (${user.email}): `)).trim().toLowerCase();
  if (typed !== user.email.toLowerCase()) {
    console.log('Email did not match. Nothing was changed.');
    await prisma.$disconnect();
    rl.close();
    return;
  }

  // One transaction so a partial removal can't leave the account half-gone.
  //
  // Each cleanup is guarded by its count. Beyond avoiding pointless queries,
  // this matters for permissions: the API only ever INSERTs into audit_log,
  // so the app's database role may well have no UPDATE grant on it. Issuing
  // an UPDATE that would affect zero rows would still fail on that missing
  // privilege and abort the whole removal for no reason.
  try {
    await prisma.$transaction(async (tx: any) => {
      if (ticketsAssigned > 0) {
        await tx.ticket.updateMany({ where: { assigneeId: user.id }, data: { assigneeId: null } });
      }
      if (auditEntries > 0) {
        await tx.auditLog.updateMany({ where: { actorId: user.id }, data: { actorId: null } });
      }
      if (notifications > 0) {
        await tx.notification.deleteMany({ where: { userId: user.id } });
      }
      await tx.user.delete({ where: { id: user.id } });
    });
  } catch (err: any) {
    // 42501 is Postgres's "insufficient privilege". Surfacing the exact GRANT
    // needed is far more useful than a stack trace, since the fix is one line
    // of SQL run as a superuser.
    const text = String(err?.message ?? err);
    const isPermission = text.includes('42501') || /permission denied/i.test(text);
    if (isPermission) {
      const table = text.match(/permission denied for table (\w+)/)?.[1] ?? '<table>';
      console.error(`\n❌ The database role used by the API lacks permission on "${table}".`);
      console.error('   Nothing was changed — the transaction rolled back.\n');
      console.error('   Grant it as a superuser, then re-run:\n');
      console.error(`     sudo -u postgres psql -d <database> -c 'GRANT UPDATE, DELETE ON ${table} TO <app_role>;'\n`);
    } else {
      console.error('\n❌ Removal failed — nothing was changed:\n', err);
    }
    await prisma.$disconnect().catch(() => {});
    rl.close();
    process.exit(1);
  }

  console.log(`\n✅ Removed ${user.name} <${user.email}>.\n`);

  await prisma.$disconnect();
  rl.close();
}

main().catch(async (err) => {
  console.error('\n❌ Removal failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
