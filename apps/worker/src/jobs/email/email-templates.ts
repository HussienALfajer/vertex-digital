import type { EmailParams, EmailTemplate } from '@vertex-digital/contracts';

/*
 * The customer emails of S01 (rule E3): Arabic, right to left, HTML with a plain-text part. A code
 * email carries its code; no email carries a password, a link with a token or text someone else
 * typed. Times are shown in Damascus time with Latin digits.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Content {
  subject: string;
  /** Paragraphs, in order. */
  lines: string[];
  /** The code, shown large in its own block. */
  code?: string;
}

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('ar-u-nu-latn', {
    timeZone: 'Asia/Damascus',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(iso));

const IGNORE = 'إذا لم تطلب هذا، تجاهل هذه الرسالة؛ لن يتغير شيء في حسابك.';
const NOT_YOU = 'إذا لم تكن أنت، غيّر كلمة المرور فورًا من صفحة الحساب أو من «نسيت كلمة المرور».';
const CODE_LIFETIME = 'الرمز صالح لمدة 10 دقائق. لا تشاركه مع أحد، فريقنا لن يطلبه منك أبدًا.';

const CONTENT: { [Template in EmailTemplate]: (params: EmailParams<Template>) => Content } = {
  customer_verify_email: ({ code }) => ({
    subject: `${code} رمز تأكيد بريدك في Vertex Digital`,
    lines: [
      'أهلًا بك في Vertex Digital. أدخل هذا الرمز لتأكيد بريدك الإلكتروني:',
      CODE_LIFETIME,
      IGNORE,
    ],
    code,
  }),
  customer_reset_password: ({ code }) => ({
    subject: `${code} رمز استعادة كلمة المرور`,
    lines: ['طلبتَ تعيين كلمة مرور جديدة لحسابك. أدخل هذا الرمز للمتابعة:', CODE_LIFETIME, IGNORE],
    code,
  }),
  customer_change_email: ({ code }) => ({
    subject: `${code} رمز تأكيد بريدك الجديد`,
    lines: [
      'طُلب نقل حساب في Vertex Digital إلى هذا البريد. أدخل هذا الرمز لتأكيده:',
      CODE_LIFETIME,
      IGNORE,
    ],
    code,
  }),
  customer_email_changed: ({ at }) => ({
    subject: 'تغيّر البريد الإلكتروني لحسابك',
    lines: [
      `تغيّر البريد الإلكتروني لحسابك في Vertex Digital بتاريخ ${formatTime(at)}، ولن تصل رسائل الحساب إلى هذا العنوان بعد الآن.`,
      'إذا لم تكن أنت، تواصل مع الدعم فورًا.',
    ],
  }),
  customer_password_changed: ({ at }) => ({
    subject: 'تغيّرت كلمة مرور حسابك',
    lines: [
      `تغيّرت كلمة مرور حسابك في Vertex Digital بتاريخ ${formatTime(at)}، وخرجتَ من الأجهزة الأخرى.`,
      'إذا لم تكن أنت، استخدم «نسيت كلمة المرور» فورًا وتواصل مع الدعم.',
    ],
  }),
  customer_new_sign_in: ({ at, browser, system, ipAddress }) => ({
    subject: 'تسجيل دخول جديد إلى حسابك',
    lines: [
      `سُجّل الدخول إلى حسابك في Vertex Digital بتاريخ ${formatTime(at)}.`,
      `الجهاز: ${browser} على ${system}${ipAddress ? `، العنوان: ${ipAddress}` : ''}.`,
      NOT_YOU,
    ],
  }),
  customer_sign_up_attempt: () => ({
    subject: 'محاولة استخدام بريدك في Vertex Digital',
    lines: [
      'حاول أحدهم إنشاء حساب أو نقل حساب إلى هذا البريد، وهو مرتبط بحسابك الحالي، فلم يتغير شيء.',
      'إذا كنت أنت ونسيت كلمة المرور، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.',
      IGNORE,
    ],
  }),
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function renderEmail<Template extends EmailTemplate>(
  template: Template,
  params: EmailParams<Template>,
): RenderedEmail {
  const content = CONTENT[template](params);
  const paragraphs = content.lines.map(
    (line) => `<p style="margin:0 0 16px;line-height:1.7">${escapeHtml(line)}</p>`,
  );
  if (content.code) {
    paragraphs.splice(
      1,
      0,
      `<p dir="ltr" style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:8px;text-align:center">${escapeHtml(content.code)}</p>`,
    );
  }
  const html = [
    '<!doctype html>',
    '<html lang="ar" dir="rtl">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    '<body style="margin:0;padding:24px;background:#f6f7f9;font-family:Tahoma,Arial,sans-serif;color:#1c2430">',
    '<div style="max-width:520px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;text-align:right">',
    '<p style="margin:0 0 24px;font-weight:700">Vertex Digital</p>',
    ...paragraphs,
    '</div>',
    '</body>',
    '</html>',
  ].join('');
  const text = [
    ...content.lines.slice(0, 1),
    ...(content.code ? [content.code] : []),
    ...content.lines.slice(1),
    '— Vertex Digital',
  ].join('\n\n');
  return { subject: content.subject, html, text };
}
