import {
  type AdjustmentCategory,
  type EmailParams,
  type EmailTemplate,
  formatUsd,
} from '@vertex-digital/contracts';

/*
 * The customer emails (S01 rule E3, S02): Arabic, right to left, HTML with a plain-text part. A
 * code email carries its code; no email carries a password, a link with a token or text someone
 * else typed. Times are shown in Damascus time with Latin digits.
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
  /** A button to a store page (a path under the store's URL), after the paragraphs. */
  link?: { label: string; path: string };
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

/** The customer-facing names of the adjustment categories (S02 rule J1). */
const CATEGORY_LABELS: Record<AdjustmentCategory, string> = {
  compensation: 'تعويض',
  correction: 'تصحيح خطأ',
  cash_refund: 'استرداد نقدي',
  manual_deposit: 'إيداع مسجَّل يدوياً',
  test_funds: 'رصيد تجريبي',
};

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
  customer_wallet_adjusted: ({ at, direction, amountUnits, category, reversal }) => {
    const amount = formatUsd(amountUnits);
    const label = reversal ? `عكس: ${CATEGORY_LABELS[category]}` : CATEGORY_LABELS[category];
    return {
      subject: direction === 'credit' ? `أُضيف ${amount} إلى رصيدك` : `خُصم ${amount} من رصيدك`,
      lines: [
        direction === 'credit'
          ? `أُضيف ${amount} إلى رصيد محفظتك في Vertex Digital بتاريخ ${formatTime(at)}.`
          : `خُصم ${amount} من رصيد محفظتك في Vertex Digital بتاريخ ${formatTime(at)}.`,
        `نوع الحركة: ${label}.`,
        'تجد تفاصيل الحركة ورصيدك الحالي في صفحة المحفظة. إذا كان لديك سؤال، تواصل مع الدعم.',
      ],
      link: { label: 'عرض المحفظة', path: '/wallet' },
    };
  },
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Renders a template; `storeUrl` is the store's origin, for the email's link. */
export function renderEmail<Template extends EmailTemplate>(
  template: Template,
  params: EmailParams<Template>,
  storeUrl: string,
): RenderedEmail {
  const content = CONTENT[template](params);
  const link = content.link && {
    label: content.link.label,
    url: new URL(content.link.path, storeUrl).toString(),
  };
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
    ...(link
      ? [
          `<p style="margin:8px 0 0"><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:10px 20px;background:#004139;color:#ffffff;border-radius:8px;text-decoration:none">${escapeHtml(link.label)}</a></p>`,
        ]
      : []),
    '</div>',
    '</body>',
    '</html>',
  ].join('');
  const text = [
    ...content.lines.slice(0, 1),
    ...(content.code ? [content.code] : []),
    ...content.lines.slice(1),
    ...(link ? [`${link.label}: ${link.url}`] : []),
    '— Vertex Digital',
  ].join('\n\n');
  return { subject: content.subject, html, text };
}
