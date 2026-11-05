import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT ?? 587) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/**
 * Fire-and-forget-friendly email sender. Never throws — logs and swallows
 * failures so a flaky SMTP connection never breaks the actual API request
 * that triggered the notification. Skips silently (with a warning) if SMTP
 * isn't configured at all, so local/dev environments don't need real creds.
 */
export async function sendMail(to: string, subject: string, html: string) {
  // Off by default for demo purposes — flip EMAIL_NOTIFICATIONS_ENABLED=true
  // in .env whenever real email sending should resume. In-app notifications
  // (the notification bell) are unaffected either way — this only gates
  // the outbound email side.
  if (process.env.EMAIL_NOTIFICATIONS_ENABLED !== 'true') {
    console.log(`[email] Sending disabled (EMAIL_NOTIFICATIONS_ENABLED != 'true') — skipped "${subject}" to ${to}`);
    return;
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn(`[email] SMTP not configured — skipped "${subject}" to ${to}`);
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error(`[email] Failed to send "${subject}" to ${to}:`, err);
  }
}

export function emailLayout(name: string, bodyHtml: string) {
  const portalUrl = process.env.PORTAL_URL || '';
  return `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;">
      <p>Hi ${name},</p>
      ${bodyHtml}
      ${portalUrl ? `<p style="margin-top:20px;"><a href="${portalUrl}" style="background:#F4051C;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Open the Doyensys Portal</a></p>` : ''}
      <p style="color:#9AA0AC;font-size:12px;margin-top:24px;">This is an automated notification from the Doyensys ITSM Portal.</p>
    </div>`;
}

// ===========================================================================
// RICH NOTIFICATION EMAILS
//
// Ticket titles, descriptions and note bodies are user input, and they end
// up inside an HTML email — so everything interpolated below is escaped.
// Without this, a ticket titled  <script>  or an apostrophe-heavy sentence
// would corrupt the markup (and worse in a webmail client that renders it).
// ===========================================================================

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trims long free text for an email preview without cutting mid-word. */
function truncate(text: string, max = 400): string {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

export type EmailAccent = 'red' | 'orange' | 'teal' | 'blue' | 'grey';

const ACCENTS: Record<EmailAccent, string> = {
  red: '#F4051C',
  orange: '#E27A00',
  teal: '#2D9A8C',
  blue: '#7798E9',
  grey: '#51565F',
};

// Priority gets its own colour so P1 is visually obvious in an inbox.
const PRIORITY_COLORS: Record<string, string> = {
  P1: '#F4051C', P2: '#E27A00', P3: '#7798E9', P4: '#9AA0AC',
};

export interface DetailRow {
  label: string;
  value: string | null | undefined;
  /** Renders the value as a coloured pill — used for priority and status. */
  badge?: boolean;
}

export interface RichEmailInput {
  recipientName: string;
  /** Big line at the top, e.g. "New incident raised". */
  headline: string;
  /** One sentence of plain-English context under the headline. */
  intro: string;
  /** The ticket's own identity line, e.g. "INC000043 — Db is slow". */
  subject?: string;
  rows?: DetailRow[];
  /** The ticket description, shown in a quoted block. */
  description?: string | null;
  /** A note or status comment attached to this particular event. */
  note?: { author: string; body: string } | null;
  /** Appended to PORTAL_URL for the "view this ticket" button. */
  ctaLabel?: string;
  accent?: EmailAccent;
}

export function richEmail(input: RichEmailInput): string {
  const portalUrl = (process.env.PORTAL_URL || '').replace(/\/+$/, '');
  const accent = ACCENTS[input.accent ?? 'red'];

  const rowsHtml = (input.rows ?? [])
    .filter((r) => r.value !== null && r.value !== undefined && String(r.value).trim() !== '')
    .map((r) => {
      const raw = String(r.value);
      let valueHtml = escapeHtml(raw);
      if (r.badge) {
        const color = PRIORITY_COLORS[raw] ?? '#51565F';
        valueHtml = `<span style="display:inline-block;background:${color};color:#ffffff;font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;">${escapeHtml(raw)}</span>`;
      }
      return `
        <tr>
          <td style="padding:7px 14px 7px 0;color:#6B7280;font-size:13px;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
          <td style="padding:7px 0;color:#1B1F27;font-size:13px;font-weight:600;vertical-align:top;">${valueHtml}</td>
        </tr>`;
    })
    .join('');

  return `
  <div style="background:#F5F6F8;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,18,24,.08);">

      <div style="background:#1B1F27;padding:16px 24px;">
        <span style="color:#F4051C;font-size:18px;font-weight:800;letter-spacing:.01em;">Doyensys</span>
        <span style="color:#9AA0AC;font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin-left:10px;">Customer Portal</span>
      </div>

      <div style="height:4px;background:${accent};"></div>

      <div style="padding:24px;">
        <p style="margin:0 0 4px;color:#1B1F27;font-size:18px;font-weight:700;">${escapeHtml(input.headline)}</p>
        <p style="margin:0 0 18px;color:#51565F;font-size:14px;line-height:1.5;">${escapeHtml(input.intro)}</p>

        ${input.subject ? `
        <div style="background:#F0F1F3;border-left:3px solid ${accent};border-radius:6px;padding:12px 14px;margin-bottom:18px;">
          <span style="color:#1B1F27;font-size:15px;font-weight:700;">${escapeHtml(input.subject)}</span>
        </div>` : ''}

        ${rowsHtml ? `<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-bottom:18px;">${rowsHtml}</table>` : ''}

        ${input.description ? `
        <p style="margin:0 0 6px;color:#6B7280;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Description</p>
        <div style="background:#F5F6F8;border-radius:6px;padding:12px 14px;margin-bottom:18px;color:#1B1F27;font-size:13.5px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(truncate(input.description))}</div>` : ''}

        ${input.note ? `
        <p style="margin:0 0 6px;color:#6B7280;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Latest update</p>
        <div style="background:#F5F6F8;border-left:3px solid #7798E9;border-radius:6px;padding:12px 14px;margin-bottom:18px;">
          <div style="color:#1B1F27;font-size:13.5px;line-height:1.55;white-space:pre-wrap;">${escapeHtml(truncate(input.note.body))}</div>
          <div style="color:#6B7280;font-size:12px;margin-top:8px;">— ${escapeHtml(input.note.author)}</div>
        </div>` : ''}

        ${portalUrl ? `
        <a href="${portalUrl}" style="display:inline-block;background:${accent};color:#ffffff;padding:11px 22px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:700;">${escapeHtml(input.ctaLabel ?? 'View in the portal')}</a>` : ''}
      </div>

      <div style="border-top:1px solid #E5E7EB;padding:14px 24px;">
        <p style="margin:0;color:#9AA0AC;font-size:11.5px;line-height:1.5;">
          Automated notification from the Doyensys Customer Portal. Replies to this address aren't monitored — please respond in the portal so the update is recorded on the ticket.
        </p>
      </div>

    </div>
  </div>`;
}
