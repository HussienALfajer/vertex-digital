import { fileURLToPath } from 'node:url';
import {
  type AdjustmentCategory,
  type CancelReason,
  type DepositRejectReason,
  type EmailParams,
  type EmailTemplate,
  formatUsd,
  type RefundReason,
  type StorePlacedPurpose,
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
  /** Images the HTML shows by `cid:`, sent inside the email so no client fetches them. */
  attachments: { cid: string; path: string; filename: string }[];
}

interface Content {
  subject: string;
  /** The title above the paragraphs; the subject when absent. */
  heading?: string;
  /** Paragraphs, in order. */
  lines: string[];
  /** The code, shown large in its own block. */
  code?: string;
  /** A button to a store page (a path under the store's URL), after the paragraphs. */
  link?: { label: string; path: string };
}

const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
    timeZone: 'Asia/Damascus',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(iso));

/*
 * F11-8: a Latin value inside an Arabic sentence is a Unicode isolate, so the sentence's order
 * holds in every client: an order number, a reference or an amount left to right (LRI … PDI,
 * kept on one line in the HTML), a product name in its own direction (FSI … PDI), so
 * "VO-7ETNBC (660 UC)" is never read as one left-to-right run.
 */
const LRI = '\u2066';
const FSI = '\u2068';
const PDI = '\u2069';
const latin = (value: string) => `${LRI}${value}${PDI}`;
const named = (value: string) => `${FSI}${value}${PDI}`;
const usd = (units: number) => latin(formatUsd(units));

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

/** The customer-facing words of the reject reasons (S03 rule RV6). */
const REJECT_REASON_LABELS: Record<DepositRejectReason, string> = {
  not_received: 'لم يصل التحويل إلى حسابنا',
  receipt_invalid: 'الإيصال غير صالح أو معدَّل',
  receipt_used: 'الإيصال مستخدم في إيداع سابق',
  reference_other_customer: 'رمز المرجع يخص حساباً آخر',
  wrong_account: 'التحويل إلى حساب غير حساب المتجر',
  wrong_network: 'التحويل على شبكة غير الشبكة المختارة',
  transfer_other_customer: 'التحويل يخص طلب إيداع آخر',
  other: 'سبب آخر، موضَّح في صفحة الإيداع',
};

/** S16 AP11: the subject and opening of `customer_order_placed_for_you`, by mode. */
const PLACED_FOR_YOU_SUBJECTS: Record<StorePlacedPurpose, string> = {
  on_behalf: 'أنشأ المتجر طلباً بطلبك',
  gift: 'هدية من المتجر',
  compensation: 'تعويض من المتجر',
};
const PLACED_FOR_YOU_LINES: Record<StorePlacedPurpose, string> = {
  on_behalf: 'أنشأ المتجر بطلبك الطلب، ودُفع من رصيد محفظتك:',
  gift: 'أهداك المتجر الطلب، من دون أن يُخصم من رصيدك شيء:',
  compensation: 'أنشأ المتجر لك تعويضاً، من دون أن يُخصم من رصيدك شيء: الطلب',
};

/** The customer-facing words of the refund reasons (S08 rule O13). */
const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  no_route: 'لا يتوفّر مورد لهذه الباقة الآن',
  routes_exhausted: 'لا يتوفّر مورد لهذه الباقة الآن',
  input_rejected: 'بيانات الحساب مرفوضة',
  admin: 'قرّرت الإدارة استرداده',
};

/** The words of a reservation cancelled by the system (S09 rule RS9). */
const CANCEL_REASON_LABELS: Record<Exclude<CancelReason, 'customer'>, string> = {
  expired: 'انتهت مدة الحجز (24 ساعة)',
  price_rose: 'تغيّر سعر الباقة',
  product_changed: 'تغيّرت بيانات الباقة',
  frozen: 'أُوقف حسابك مؤقتاً، تواصل مع الدعم',
};

/** A browser or system the user agent did not name reads as "unknown", in Arabic (feature 2 audit). */
const deviceName = (name: string) => (name === 'Unknown' ? 'غير معروف' : name);

const orderPage = (orderId: string) => ({ label: 'عرض الطلب', path: `/orders/${orderId}` });

const depositPage = (depositId: string) => ({
  label: 'عرض الإيداع',
  path: `/wallet/deposits/${depositId}`,
});

const CONTENT: { [Template in EmailTemplate]: (params: EmailParams<Template>) => Content } = {
  customer_verify_email: ({ code }) => ({
    subject: `${code} رمز تأكيد بريدك في Vertex Digital`,
    heading: 'أكّد بريدك الإلكتروني',
    lines: [
      'أهلًا بك في Vertex Digital. أدخل هذا الرمز لتأكيد بريدك الإلكتروني:',
      CODE_LIFETIME,
      IGNORE,
    ],
    code,
  }),
  customer_reset_password: ({ code }) => ({
    subject: `${code} رمز استعادة كلمة المرور`,
    heading: 'استعادة كلمة المرور',
    lines: ['طلبتَ تعيين كلمة مرور جديدة لحسابك. أدخل هذا الرمز للمتابعة:', CODE_LIFETIME, IGNORE],
    code,
  }),
  customer_change_email: ({ code }) => ({
    subject: `${code} رمز تأكيد بريدك الجديد`,
    heading: 'أكّد بريدك الجديد',
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
      `الجهاز: ${deviceName(browser)} على ${deviceName(system)}${ipAddress ? `، عنوان الإنترنت: ${ipAddress}` : ''}.`,
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
    const amount = usd(amountUnits);
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
  // F4-7: the same events serve Sham Cash and USDT deposits, so the words name neither.
  customer_deposit_credited: ({ at, depositId, referenceCode, creditedUsdUnits }) => ({
    subject: `أُضيف ${usd(creditedUsdUnits)} إلى رصيدك من إيداعك ${latin(referenceCode)}`,
    lines: [
      `اعتُمد إيداعك ${latin(referenceCode)} وأُضيف ${usd(creditedUsdUnits)} إلى رصيد محفظتك بتاريخ ${formatTime(at)}.`,
      'تجد تفاصيل الإيداع ورصيدك الحالي في صفحة الإيداع. إذا كان لديك سؤال، تواصل مع الدعم.',
    ],
    link: depositPage(depositId),
  }),
  customer_deposit_rejected: ({ depositId, referenceCode, reason }) => ({
    subject: `لم يُعتمد إيداعك ${latin(referenceCode)}`,
    lines: [
      `راجعنا إيداعك ${latin(referenceCode)} ولم نتمكن من اعتماده، ولم يُضف شيء إلى رصيدك.`,
      `السبب: ${REJECT_REASON_LABELS[reason]}.`,
      'إذا كنت حوّلت المبلغ فعلًا، تواصل مع الدعم ومعك إثبات التحويل: رقم العملية من تطبيق شام كاش، أو رمز التحويل (TXID) لإيداع USDT.',
    ],
    link: depositPage(depositId),
  }),
  customer_deposit_receipt_requested: ({ depositId, referenceCode }) => ({
    subject: `نحتاج إيصالًا أوضح لإيداعك ${latin(referenceCode)}`,
    lines: [
      `راجعنا إيداعك ${latin(referenceCode)} ونحتاج صورة أوضح لإيصال التحويل قبل اعتماده.`,
      'افتح صفحة الإيداع وأرسل لقطة شاشة كاملة وواضحة للإيصال خلال 24 ساعة.',
    ],
    link: depositPage(depositId),
  }),
  // S08: the order number and product, never its codes or account fields; the codes are on the
  // order page only.
  customer_order_delivered: ({ at, orderId, orderNumber, productNameAr, quantity }) => ({
    subject: `سُلّم طلبك ${latin(orderNumber)}`,
    lines: [
      `سُلّم طلبك ${latin(orderNumber)} (${named(productNameAr)}${quantity > 1 ? ` × ${quantity}` : ''}) بتاريخ ${formatTime(at)}.`,
      'تجد تفاصيل الطلب في صفحته، والأكواد هناك فقط إن كان الطلب أكواداً.',
    ],
    link: orderPage(orderId),
  }),
  customer_order_partially_refunded: ({
    at,
    orderId,
    orderNumber,
    productNameAr,
    deliveredQuantity,
    refundedQuantity,
    refundedUsdUnits,
  }) => ({
    subject: `سُلّم جزء من طلبك ${latin(orderNumber)} واسترد الباقي`,
    lines: [
      `سُلّم ${deliveredQuantity} من طلبك ${latin(orderNumber)} (${named(productNameAr)}) بتاريخ ${formatTime(at)}، ولم يتوفّر الباقي (${refundedQuantity}).`,
      // S16 AP11: an order the store paid returns nothing to the wallet.
      refundedUsdUnits === null
        ? 'تعذّر تنفيذ الكمية الباقية، ولم يُخصم من رصيدك شيء.'
        : `أُعيد ${usd(refundedUsdUnits)} إلى رصيد محفظتك عن الكمية التي لم تُسلَّم.`,
    ],
    link: orderPage(orderId),
  }),
  customer_order_refunded: ({
    at,
    orderId,
    orderNumber,
    productNameAr,
    refundedUsdUnits,
    reason,
  }) =>
    // S16 AP11: an order the store paid returns nothing to the wallet.
    refundedUsdUnits === null
      ? {
          subject: `تعذّر تنفيذ الطلب ${latin(orderNumber)}`,
          lines: [
            `تعذّر تنفيذ الطلب ${latin(orderNumber)} (${named(productNameAr)}) الذي أنشأه المتجر لك، بتاريخ ${formatTime(at)}. لم يُخصم من رصيدك شيء.`,
            `السبب: ${REFUND_REASON_LABELS[reason]}.`,
          ],
          link: orderPage(orderId),
        }
      : {
          subject: `أُعيد ${usd(refundedUsdUnits)} إلى رصيدك عن الطلب ${latin(orderNumber)}`,
          lines: [
            `لم نتمكن من تنفيذ طلبك ${latin(orderNumber)} (${named(productNameAr)})، فأُعيد ${usd(refundedUsdUnits)} كاملاً إلى رصيد محفظتك بتاريخ ${formatTime(at)}.`,
            `السبب: ${REFUND_REASON_LABELS[reason]}.`,
          ],
          link: orderPage(orderId),
        },
  // S16 AP11: an order the store placed for the customer; the note is the store's own words.
  customer_order_placed_for_you: ({
    at,
    orderId,
    orderNumber,
    productNameAr,
    purpose,
    message,
  }) => ({
    subject: `${PLACED_FOR_YOU_SUBJECTS[purpose]}: ${latin(orderNumber)}`,
    lines: [
      `${PLACED_FOR_YOU_LINES[purpose]} ${latin(orderNumber)} (${named(productNameAr)}) بتاريخ ${formatTime(at)}.`,
      ...(message ? [`رسالة المتجر: ${message}`] : []),
      'تتابع تنفيذه في صفحة الطلب، والأكواد هناك فقط إن كان الطلب أكواداً.',
    ],
    link: orderPage(orderId),
  }),
  customer_order_cancelled: ({ at, orderId, orderNumber, productNameAr, reason }) => ({
    subject: `أُلغي طلبك المحجوز ${latin(orderNumber)}`,
    lines: [
      `أُلغي طلبك المحجوز ${latin(orderNumber)} (${named(productNameAr)}) بتاريخ ${formatTime(at)}، ولم يُخصم من رصيدك شيء.`,
      `السبب: ${CANCEL_REASON_LABELS[reason]}.`,
    ],
    link: orderPage(orderId),
  }),
  // S10 rule CT8: the counts and the refund, never fields, codes or gift texts.
  customer_checkout_finished: ({
    at,
    checkoutId,
    orderCount,
    delivered,
    partiallyRefunded,
    refunded,
    refundedUsdUnits,
  }) => {
    const counts = [
      delivered > 0 && `سُلّم ${delivered}`,
      partiallyRefunded > 0 && `سُلّم جزئياً ${partiallyRefunded}`,
      refunded > 0 && `استُرد ${refunded}`,
    ].filter((part) => part !== false);
    return {
      subject: `اكتملت سلتك: ${counts.join('، ')}`,
      lines: [
        `اكتملت طلبات سلتك (${orderCount}) بتاريخ ${formatTime(at)}: ${counts.join('، ')}.`,
        ...(refundedUsdUnits > 0
          ? [`أُعيد ${usd(refundedUsdUnits)} إلى رصيد محفظتك عن ما لم يُسلَّم.`]
          : []),
      ],
      link: { label: 'عرض طلبات السلة', path: `/orders?checkout=${checkoutId}` },
    };
  },
  // S12 TK9: the ticket number and a link, never the reply.
  customer_ticket_replied: ({ ticketId, number }) => ({
    subject: `ردّ فريق الدعم على تذكرتك ${latin(number)}`,
    lines: [`ردّ فريق Vertex Digital على تذكرتك ${latin(number)}. افتح التذكرة لقراءة الرد.`],
    link: { label: 'عرض التذكرة', path: `/support/${ticketId}` },
  }),
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/*
 * The brand frame of every email (brand/identity.md, 2026-10-15 system test F2-5): the sand logo on
 * a Vertex Green band, a white card on the light background, the sand start bar on the title, the
 * code in a framed block and the action in Vertex Green. Tables and inline styles only, since
 * email clients ignore style sheets; physical sides, since they ignore logical ones (RTL: the
 * start is the right).
 */
const COLORS = {
  green: '#004139',
  sand: '#B9A87A',
  background: '#F4F8F7',
  border: '#D4DBD9',
  text: '#222827',
  muted: '#616866',
};
const FONT = "Tahoma,'Segoe UI',Arial,sans-serif";
/** Latin digits of the code in the brand's Latin face where the client has it. */
const CODE_FONT = "Montserrat,'Segoe UI',Tahoma,Arial,sans-serif";

const LOGO_CID = 'logo@vertex-digital';
const LOGO = {
  cid: LOGO_CID,
  // The repository's brand file (brand/README.md): releases are full checkouts (deploy.sh).
  path: fileURLToPath(
    new URL('../../../../../brand/logo/png/vertex-logo-gold.png', import.meta.url),
  ),
  filename: 'vertex-digital.png',
};

/** Escaped text whose left-to-right isolates also stay whole on one line (F11-8). */
const bidiHtml = (value: string) =>
  escapeHtml(value).replace(
    /\u2066([^\u2066-\u2069]*)\u2069/g,
    `<span dir="ltr" style="white-space:nowrap">${LRI}$1${PDI}</span>`,
  );

const paragraph = (line: string) =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:26px;color:${COLORS.text}">${bidiHtml(line)}</p>`;

const codeBlock = (code: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr><td dir="ltr" align="center" style="padding:18px 12px;background:${COLORS.background};border:1px solid ${COLORS.border};border-radius:8px;font-family:${CODE_FONT};font-size:34px;line-height:40px;font-weight:700;letter-spacing:10px;color:${COLORS.green}">${escapeHtml(code)}</td></tr></table>`;

const button = (link: { label: string; url: string }) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="background:${COLORS.green};border-radius:6px"><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">${escapeHtml(link.label)}</a></td></tr></table>`;

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
  const store = new URL(storeUrl);
  const body = content.lines.map(paragraph);
  if (content.code) body.splice(1, 0, codeBlock(content.code));
  const html = [
    '<!doctype html>',
    '<html lang="ar" dir="rtl">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>',
    escapeHtml(content.subject),
    '</title></head>',
    `<body style="margin:0;padding:0;background:${COLORS.background};font-family:${FONT};color:${COLORS.text}">`,
    // The inbox preview: the first paragraph, hidden in the email itself.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(content.lines[0] ?? '')}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.background}"><tr><td align="center" style="padding:24px 12px">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">',
    `<tr><td align="center" style="padding:28px 24px 24px;background:${COLORS.green};border-radius:12px 12px 0 0"><img src="cid:${LOGO_CID}" width="88" height="89" alt="Vertex Digital" style="display:block;border:0;width:88px;height:89px"></td></tr>`,
    `<tr><td style="height:4px;line-height:4px;font-size:0;background:${COLORS.sand}">&nbsp;</td></tr>`,
    `<tr><td dir="rtl" style="padding:32px 28px 24px;background:#ffffff;border:1px solid ${COLORS.border};border-top:0;border-radius:0 0 12px 12px;text-align:right">`,
    `<h1 style="margin:0 0 20px;padding-right:12px;border-right:4px solid ${COLORS.sand};font-size:20px;line-height:30px;font-weight:700;color:${COLORS.green}">${bidiHtml(content.heading ?? content.subject)}</h1>`,
    ...body,
    ...(link ? [button(link)] : []),
    '</td></tr>',
    `<tr><td dir="rtl" align="center" style="padding:20px 16px 8px;font-size:12px;line-height:20px;color:${COLORS.muted}">`,
    'Vertex Digital · شحن الألعاب والتطبيقات من محفظتك<br>',
    `<a href="${escapeHtml(store.origin)}" style="color:${COLORS.muted};text-decoration:underline">${escapeHtml(store.host)}</a>`,
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('');
  const text = [
    content.heading ?? content.subject,
    ...content.lines.slice(0, 1),
    ...(content.code ? [content.code] : []),
    ...content.lines.slice(1),
    ...(link ? [`${link.label}: ${link.url}`] : []),
    `— Vertex Digital · ${store.host}`,
  ].join('\n\n');
  return { subject: content.subject, html, text, attachments: [LOGO] };
}
