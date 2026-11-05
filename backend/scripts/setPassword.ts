import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/authService';

// ===========================================================================
// SET / RESET A USER'S PASSWORD
//
// Passwords are stored as bcrypt hashes, never as text, so this cannot be
// done with plain SQL — the new password has to be hashed with the same
// function the login path verifies against. That's what this script is for.
//
// It is also the way to lock someone out without deleting them: set a long
// random password nobody knows. Their history stays intact (tickets, notes
// and reports keep a valid owner) but the account can no longer sign in.
//
// Usage:  npx tsx scripts/setPassword.ts     (or: npm run set-password)
// ===========================================================================

const prisma = new PrismaClient();
const rl = readline.createInterface({ input: stdin, output: stdout });

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomFillSync(new Uint32Array(14)))
    .map((n) => chars[n % chars.length])
    .join('');
}

async function main() {
  console.log('\n=== Doyensys Portal — Set a Password ===\n');

  const users = await prisma.user.findMany({
    include: { org: { select: { name: true } } },
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

  const choice = Number((await rl.question('\nSelect user number: ')).trim()) - 1;
  const user = users[choice];
  if (!user) {
    console.error('Invalid selection. Aborting.');
    process.exit(1);
  }

  console.log(`\nSetting a new password for ${user.name} <${user.email}>.`);
  console.log('Leave blank to generate a strong random one (use this to lock an account).');

  let password = (await rl.question('New password: ')).trim();
  const wasGenerated = !password;
  if (!password) {
    password = generatePassword();
  } else if (password.length < 8) {
    // Not enforced by the API today, but a reset is the wrong moment to
    // quietly hand out something trivially guessable.
    const proceed = (await rl.question('That is under 8 characters. Use it anyway? (y/n) [n]: ')).trim().toLowerCase();
    if (!proceed.startsWith('y')) {
      console.log('Aborted. Nothing was changed.');
      await prisma.$disconnect();
      rl.close();
      return;
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password) },
  });

  console.log(`\n✅ Password updated for ${user.email}`);
  console.log(`   New password: ${password}`);
  if (wasGenerated) {
    console.log('   (randomly generated — share it securely, it is not recoverable later)');
  }
  console.log('\nAny existing sign-in stays valid until its token expires (8h by default).');
  console.log('The new password applies from their next sign-in.\n');

  await prisma.$disconnect();
  rl.close();
}

main().catch(async (err) => {
  console.error('\n❌ Failed:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
