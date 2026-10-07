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
}

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
    });
    if (this.logDir) {
      await mkdir(this.logDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(':', '-');
      await writeFile(join(this.logDir, `${stamp}-${email.id}.eml`), info.message as Buffer);
    }
  }
}
