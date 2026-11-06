import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Envoi d'e-mails par SMTP (mot de passe oublié). Configuration par l'environnement :
 *   SMTP_URL   smtp(s)://utilisateur:motdepasse@hôte:port  (secret : jamais renvoyé ni journalisé)
 *   MAIL_FROM  « Nuera Dev <hello@nuera.studio> »
 * Sans SMTP_URL, l'envoi est désactivé et l'interface le dit (aucun bouton mort).
 * `SMTP_URL=json` (tests) : aucun envoi réseau, le message est rendu en JSON.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let cached: { url: string; transport: Transporter } | null = null;

export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim() && process.env.MAIL_FROM?.trim());
}

function transport(): Transporter {
  const url = process.env.SMTP_URL?.trim() ?? '';
  if (cached?.url === url) return cached.transport;
  const created = url === 'json' ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(url);
  cached = { url, transport: created };
  return created;
}

/** Envoie un message ; lève une erreur sans jamais y inclure la configuration SMTP. */
export async function sendMail(message: MailMessage): Promise<void> {
  if (!isMailConfigured()) throw new Error("L'envoi d'e-mails n'est pas configuré (SMTP_URL, MAIL_FROM).");
  try {
    await transport().sendMail({ from: process.env.MAIL_FROM!.trim(), ...message });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    // oxlint-disable-next-line eslint/preserve-caught-error -- la cause peut contenir la configuration SMTP
    throw new Error(`Envoi de l'e-mail impossible${code ? ` (${code})` : ''}.`);
  }
}

/** Échappe une valeur insérée dans le HTML d'un e-mail. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
