/**
 * Real email, sent as uap@omokoda.space over standard SMTP (mail.spacemail.com:465, SSL) --
 * not the Spacemail MCP server, which turned out to require a full interactive OAuth sign-in
 * (verified only against Claude's own connector UI) and cannot authenticate with a static
 * API key from a server-side client. Standard SMTP/IMAP with a mailbox password is the real,
 * reliable path every other mail client uses against Spacemail, so that's what this is.
 */
import nodemailer from 'nodemailer';
import { env } from '../env.js';

export function isEmailConfigured(): boolean {
  return Boolean(env.spacemailUser && env.spacemailPass);
}

let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
function client() {
  if (!isEmailConfigured()) throw new Error('Email is not configured (SPACEMAIL_SMTP_PASS is not set).');
  return transporter ??= nodemailer.createTransport({
    host: 'mail.spacemail.com',
    port: 465,
    secure: true,
    auth: { user: env.spacemailUser, pass: env.spacemailPass },
  });
}

export async function sendEmail(input: { to: string; subject: string; text: string }): Promise<{ messageId: string }> {
  const info = await client().sendMail({ from: env.spacemailUser, to: input.to, subject: input.subject.slice(0, 200), text: input.text.slice(0, 50_000) });
  return { messageId: info.messageId };
}
