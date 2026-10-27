import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';

export interface OutgoingEmail {
  /** The outbox row id: names the file in log mode. */
  id: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Inline images the HTML names by `cid:`. */
  attachments: { cid: string; path: string; filename: string }[];
}

/**
 * Nodemailer waits up to 2 minutes to connect and 10 for the socket by default, while `email.send`
 * holds the outbox row's transaction and the one-at-a-time queue: a hung server fails in seconds
 * instead (audit A07-29).
 */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
  socketTimeout: 30_000,
} as const;

/**
 * Sends emails over SMTP (Nodemailer), or, in log mode (development and tests, rule E5), builds
 * the same message and writes it as an `.eml` file under `EMAIL_LOG_DIR` instead of sending it.
 */
@Injectable()
export class Mailer {
  private readonly transport: Transporter;
  private readonly logDir: string | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    if (env.EMAIL_TRANSPORT === 'smtp') {
      this.transport = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
        ...SMTP_TIMEOUTS,
      });
      this.logDir = null;
    } else {
      this.transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'unix',
      });
      this.logDir = resolve(env.EMAIL_LOG_DIR);
    }
  }

  async send(email: OutgoingEmail): Promise<void> {
    const info = await this.transport.sendMail({
      from: { name: 'Vertex Digital', address: this.env.EMAIL_FROM },
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments.map((file) => ({ ...file, contentDisposition: 'inline' })),
    });
    if (this.logDir) {
      await mkdir(this.logDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(':', '-');
      await writeFile(join(this.logDir, `${stamp}-${email.id}.eml`), info.message as Buffer);
    }
  }
}
