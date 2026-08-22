/**
 * Outgoing email via the local Postfix SMTP relay.
 *
 * Postfix on this host listens on 127.0.0.1:25 (and :587) and trusts the
 * loopback network, so unauthenticated submission is sufficient. The
 * transport is a lazily-created singleton so the SMTP connection pool
 * persists across scheduled runs.
 *
 * `DIGEST_TO` (from config) is used as the default recipient, but every
 * call can override `to` for flexibility.
 */

import os from 'node:os';
import nodemailer, { type Transporter } from 'nodemailer';
import { DIGEST_SMTP_HOST, DIGEST_SMTP_PORT, DIGEST_TO } from '../config.js';

let transport: Transporter | null = null;

/**
 * From address for server-sent email (digests, maintenance commits) —
 * `DIGEST_FROM` when set, else `notebook-digest@<hostname>`. The local MTA
 * typically rewrites it to something deliverable anyway.
 */
export function fromAddress(): string {
  return process.env.DIGEST_FROM || `notebook-digest@${os.hostname()}`;
}

/** Get (or lazily create) the shared SMTP transport. */
function getTransport(): Transporter {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: DIGEST_SMTP_HOST,
    port: DIGEST_SMTP_PORT,
    secure: false,
    // Postfix presents a self-signed / hostname-mismatched cert on the
    // loopback interface; we trust the local MTA unconditionally.
    tls: { rejectUnauthorized: false },
    // No auth — loopback is in Postfix's mynetworks.
    pool: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return transport;
}

export interface SendMailInput {
  to?: string;
  subject: string;
  /** Plain-text body. Sent as text/plain only — keeps digests readable everywhere. */
  body: string;
}

export interface SendMailResult {
  messageId: string;
  response: string;
}

/**
 * Send a plain-text email via the local MTA. Throws on SMTP failure so the
 * caller can mark the digest as failed and log the reason.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const to = input.to || DIGEST_TO;
  if (!to) {
    throw new Error('No recipient configured (set DIGEST_TO).');
  }

  const info = await getTransport().sendMail({
    from: fromAddress(),
    to,
    subject: input.subject,
    text: input.body,
  });

  return {
    messageId: info.messageId,
    response: info.response,
  };
}
