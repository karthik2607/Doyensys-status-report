import 'dotenv/config';
import nodemailer from 'nodemailer';

// Standalone SMTP connectivity check — separate from the app's own
// sendMail() so it works even while EMAIL_NOTIFICATIONS_ENABLED=false,
// and reads the same .env keys you've already set:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
//
// Usage (from doyensys-backend):
//   npx tsx scripts/testEmail.ts you@yourcompany.com

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npx tsx scripts/testEmail.ts <recipient-email>');
    process.exit(1);
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user;

  if (!host || !user || !pass) {
    console.error('Missing SMTP_HOST, SMTP_USER, or SMTP_PASS in .env — set those first.');
    process.exit(1);
  }

  console.log(`Connecting to ${host}:${port} as ${user} ...`);
  const transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465, // OCI Email Delivery: 587 = STARTTLS (secure:false), 465 = implicit TLS
    auth: { user, pass },
  });

  try {
    await transporter.verify();
    console.log('SMTP connection + auth OK.');
  } catch (err) {
    console.error('SMTP verify failed:', err);
    process.exit(1);
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'Doyensys Portal — SMTP test',
      html: '<p>This is a test email from the Doyensys Portal backend. If you got this, outbound SMTP is working.</p>',
    });
    console.log('Sent OK. Message ID:', info.messageId);
  } catch (err) {
    console.error('Send failed:', err);
    process.exit(1);
  }
}

main();
