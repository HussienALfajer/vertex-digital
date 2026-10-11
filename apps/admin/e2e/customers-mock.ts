import {
  type AdminCustomer,
  type AdminCustomerRow,
  type AdminOrder,
  type AdminTicket,
  type AdminTicketSummary,
  type AuditEntry,
  adminCreateTicketSchema,
  type CustomerLimitOverrides,
  type CustomerNote,
  type CustomerSignals,
  type CustomerStatus,
  classifyCustomerSearch,
  createCustomerNoteSchema,
  customerLimits,
  customerStateChangeSchema,
  DEPOSIT_SETTINGS_DEFAULTS,
  NO_LIMIT_OVERRIDES,
  type SupportSettings,
  supportSettingsSchema,
  type TicketCategory,
  type TicketMessage,
  type TicketStatus,
  ticketLinkValid,
  ticketMessageSchema,
  ticketTransition,
  updateCustomerLimitsSchema,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';
import { ORDER_CUSTOMER_ID } from './orders-mock';

/*
 * The customers and support API of S12 as the panel sees it: five customers (two sharing a phone
 * and an IP, a frozen one, an archived one, a test one) with their profiles, sign-ins, sessions,
 * notes and history; the state changes with re-authentication and their refusals (CF1, CF6, LM5,
 * AR1, AR3, SN1) on the contracts' rules (`customerLimits`, the change schemas); three tickets
 * with the queue's tabs and filters, replies and admin-opened tickets read from their multipart
 * bodies with `Idempotency-Key` replays, closing, images, and the support settings (SC1).
 */

type Body = Record<string, unknown> | null;

/** What a request carries besides its JSON body: the raw multipart and the key. */
export interface RawRequest {
  contentType: string;
  raw: Buffer | null;
  idempotencyKey: string | null;
}

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, details },
});

const ok = (json: unknown, status = 200): Answer => ({ status, json });

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const USD = 1_000_000;

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** The customers the specs open: A is the orders mock's customer, so her orders tab has rows. */
export const CUSTOMER_IDS = {
  sara: ORDER_CUSTOMER_ID,
  layla: id(2),
  rami: id(3),
  omar: id(4),
  test: id(5),
};

export const TICKET_IDS = { waiting: id(101), answered: id(102), closed: id(103) };

/** The images of the waiting ticket's first message. */
export const ATTACHMENT_IDS = [id(201), id(202)];

interface MockCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  isTest: boolean;
  emailVerified: boolean;
  established: boolean;
  createdAt: string;
  frozenAt: string | null;
  archivedAt: string | null;
  statusChange: { reason: string | null; at: string } | null;
  overrides: CustomerLimitOverrides;
  balanceUnits: number;
  deliveredOrders: number;
  lastOrderAt: string | null;
  reservations: number;
  openOrders: boolean;
  sessions: {
    id: string;
    ipAddress: string;
    userAgent: string;
    createdAt: string;
    lastActiveAt: string;
  }[];
  signIns: { id: string; ipAddress: string; userAgent: string; createdAt: string }[];
}

interface MockTicket {
  id: string;
  number: string;
  customerId: string;
  category: TicketCategory;
  orderId: string | null;
  depositId: string | null;
  subject: string;
  status: TicketStatus;
  openedBy: 'customer' | 'admin';
  closedAt: string | null;
  closedBy: 'customer' | 'admin' | 'system' | null;
  createdAt: string;
  messages: TicketMessage[];
}

function customer(
  n: keyof typeof CUSTOMER_IDS,
  fields: Partial<MockCustomer> & Pick<MockCustomer, 'name' | 'email' | 'phone'>,
): MockCustomer {
  return {
    id: CUSTOMER_IDS[n],
    isTest: false,
    emailVerified: true,
    established: false,
    createdAt: at(24 * 40),
    frozenAt: null,
    archivedAt: null,
    statusChange: null,
    overrides: NO_LIMIT_OVERRIDES,
    balanceUnits: 0,
    deliveredOrders: 0,
    lastOrderAt: null,
    reservations: 0,
    openOrders: false,
    sessions: [],
    signIns: [],
    ...fields,
  };
}

function message(
  n: number,
  author: TicketMessage['author'],
  body: string,
  hoursAgo: number,
  attachments: string[] = [],
): TicketMessage {
  return { id: id(300 + n), author, body, attachments, createdAt: at(hoursAgo) };
}

/** A multipart body's text fields and how many files it carries (`files`). */
export function multipart(request: RawRequest): { fields: Record<string, string>; files: number } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(request.contentType);
  const fields: Record<string, string> = {};
  let files = 0;
  if (!boundary || !request.raw) return { fields, files };
  const text = request.raw.toString('latin1');
  for (const part of text.split(`--${boundary[1] ?? boundary[2]}`)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (!name) continue;
    if (/filename="/.test(head)) {
      files += 1;
    } else {
      const value = part.slice(split + 4).replace(/\r\n$/, '');
      fields[name] = Buffer.from(value, 'latin1').toString('utf8');
    }
  }
  return { fields, files };
}

export class CustomersMock {
  customers: MockCustomer[] = [
    customer('sara', {
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      phone: '+963944123456',
      established: true,
      createdAt: at(24 * 120),
      balanceUnits: 25 * USD,
      deliveredOrders: 3,
      lastOrderAt: at(2),
      reservations: 1,
      sessions: [
        {
          id: id(401),
          ipAddress: '5.0.0.1',
          userAgent: CHROME_WINDOWS,
          createdAt: at(30),
          lastActiveAt: at(1),
        },
        {
          id: id(402),
          ipAddress: '31.9.48.7',
          userAgent: SAFARI_IPHONE,
          createdAt: at(72),
          lastActiveAt: at(20),
        },
      ],
      signIns: [
        { id: id(411), ipAddress: '5.0.0.1', userAgent: CHROME_WINDOWS, createdAt: at(30) },
        { id: id(412), ipAddress: '31.9.48.7', userAgent: SAFARI_IPHONE, createdAt: at(72) },
      ],
    }),
    customer('layla', {
      name: 'ليلى حداد',
      email: 'layla@example.com',
      phone: '+963944123456',
      createdAt: at(24 * 3),
      signIns: [{ id: id(421), ipAddress: '5.0.0.1', userAgent: CHROME_WINDOWS, createdAt: at(5) }],
    }),
    customer('rami', {
      name: 'رامي سليمان',
      email: 'rami@example.com',
      phone: '+963933222111',
      established: true,
      frozenAt: at(6),
      statusChange: { reason: 'إيصالات مكررة قيد التحقق', at: at(6) },
      balanceUnits: 12 * USD,
      deliveredOrders: 1,
      lastOrderAt: at(24 * 5),
    }),
    customer('omar', {
      name: 'عمر الخطيب',
      email: 'omar@example.com',
      phone: '+963955000777',
      archivedAt: at(24 * 9),
      statusChange: { reason: 'طلب العميل إغلاق حسابه', at: at(24 * 9) },
    }),
    customer('test', {
      name: 'عميل تجريبي',
      email: 'qa@example.com',
      phone: '+963966111222',
      isTest: true,
    }),
  ];
  notes: (CustomerNote & { customerId: string })[] = [
    {
      id: id(501),
      customerId: CUSTOMER_IDS.sara,
      body: 'عميلة قديمة وموثوقة. تشحن عادة ببجي.',
      pinned: false,
      createdAt: at(24 * 20),
      archivedAt: null,
    },
  ];
  tickets: MockTicket[] = [
    {
      id: TICKET_IDS.waiting,
      number: 'VT-7KQ2MX',
      customerId: CUSTOMER_IDS.sara,
      category: 'order',
      orderId: null,
      depositId: null,
      subject: 'لم يصل الشحن بعد',
      status: 'open',
      openedBy: 'customer',
      closedAt: null,
      closedBy: null,
      createdAt: at(3),
      messages: [
        message(
          1,
          'customer',
          'مرحبًا، دفعت قبل ساعة ولم يصل الشحن.\nهذه لقطة الشاشة، وهذا رابط الطلب: https://example.com/order',
          3,
          ATTACHMENT_IDS,
        ),
      ],
    },
    {
      id: TICKET_IDS.answered,
      number: 'VT-3HWX9P',
      customerId: CUSTOMER_IDS.rami,
      category: 'account',
      orderId: null,
      depositId: null,
      subject: 'لماذا لا أستطيع الإيداع؟',
      status: 'answered',
      openedBy: 'customer',
      closedAt: null,
      closedBy: null,
      createdAt: at(26),
      messages: [
        message(2, 'customer', 'تظهر لي رسالة أن الحساب موقوف.', 26),
        message(3, 'admin', 'نراجع حسابك الآن، وسنعود إليك قريبًا.', 25),
      ],
    },
    {
      id: TICKET_IDS.closed,
      number: 'VT-5CN8DR',
      customerId: CUSTOMER_IDS.sara,
      category: 'other',
      orderId: null,
      depositId: null,
      subject: 'سؤال عن طرق الدفع',
      status: 'closed',
      openedBy: 'customer',
      closedAt: at(24 * 10),
      closedBy: 'system',
      createdAt: at(24 * 18),
      messages: [
        message(4, 'customer', 'هل تقبلون USDT على شبكة BEP20؟', 24 * 18),
        message(5, 'admin', 'نعم، على TRC20 وBEP20.', 24 * 17),
      ],
    },
  ];
  settings: SupportSettings = { telegramUrl: null };
  /** The customer's own history (CS4), newest first; changes add theirs. */
  history: AuditEntry[] = [];
  private readonly ticketKeys = new Map<string, { body: string; ticketId: string }>();

  constructor(
    private readonly reauthenticationRequired: () => boolean,
    private readonly orders: () => AdminOrder[],
    private readonly audit: (entry: AuditEntry) => void,
  ) {
    // The waiting ticket is about Sara's delivered order.
    const delivered = this.orders().find((order) => order.customer.id === CUSTOMER_IDS.sara);
    const waiting = this.tickets[0];
    if (waiting && delivered) waiting.orderId = delivered.id;
    this.history = [
      this.entry('customer.note_added', 'customer_note', id(501), CUSTOMER_IDS.sara, null, 24 * 20),
      this.entry(
        'ticket.opened',
        'support_ticket',
        TICKET_IDS.waiting,
        CUSTOMER_IDS.sara,
        null,
        3,
        {
          actorKind: 'customer',
          actorId: CUSTOMER_IDS.sara,
          actorName: 'سارة الأحمد',
          channel: 'store',
        },
      ),
    ];
  }

  private entry(
    action: string,
    entityType: string,
    entityId: string,
    customerId: string,
    reason: string | null,
    hoursAgo = 0,
    actor: Partial<AuditEntry> = {},
  ): AuditEntry & { customerId: string } {
    return {
      id: crypto.randomUUID(),
      occurredAt: at(hoursAgo),
      actorKind: 'admin',
      actorId: '0199a000-0000-7000-8000-000000000001',
      actorName: 'ريم الخطيب',
      channel: 'admin',
      action,
      entityType,
      entityId,
      reason,
      details: {},
      ipAddress: '5.0.0.9',
      userAgent: CHROME_WINDOWS,
      ...actor,
      customerId,
    } as AuditEntry & { customerId: string };
  }

  /** A change's audit entry: in the customer's history and in the audit log. */
  private record(
    action: string,
    entityType: string,
    entityId: string,
    customerId: string,
    reason: string | null = null,
  ) {
    const entry = this.entry(action, entityType, entityId, customerId, reason);
    this.history = [entry, ...this.history];
    this.audit(entry);
  }

  status(row: MockCustomer): CustomerStatus {
    if (row.archivedAt) return 'archived';
    if (row.frozenAt) return 'frozen';
    return 'active';
  }

  find(customerId: string): MockCustomer | undefined {
    return this.customers.find((row) => row.id === customerId);
  }

  private pinned(customerId: string) {
    return (
      this.notes.find(
        (note) => note.customerId === customerId && note.pinned && !note.archivedAt,
      ) ?? null
    );
  }

  /** Rule CS5: the same phone, and a sign-in from the same IP in the window. */
  signals(row: MockCustomer): CustomerSignals {
    const others = this.customers.filter((other) => other.id !== row.id);
    const phone = others.filter((other) => other.phone === row.phone);
    const ips = new Set(row.signIns.map((item) => item.ipAddress));
    const ip = others
      .map((other) => ({
        other,
        shared: [...new Set(other.signIns.map((item) => item.ipAddress))].filter((value) =>
          ips.has(value),
        ),
      }))
      .filter((item) => item.shared.length > 0);
    const brief = (other: MockCustomer) => ({ id: other.id, name: other.name, email: other.email });
    return {
      sharedPhone: { count: phone.length, customers: phone.map(brief) },
      sharedIp: {
        count: ip.length,
        customers: ip.map((item) => ({ ...brief(item.other), ipAddresses: item.shared })),
      },
    };
  }

  /** Rule CS6: what the deposit, order and ticket pages show beside the customer. */
  marks(row: MockCustomer) {
    const signals = this.signals(row);
    return {
      status: this.status(row),
      pinnedNote: this.pinned(row.id)?.body ?? null,
      signalsCount: signals.sharedPhone.count + signals.sharedIp.count,
    };
  }

  private row(row: MockCustomer): AdminCustomerRow {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      isTest: row.isTest,
      status: this.status(row),
      createdAt: row.createdAt,
      balanceUnits: row.balanceUnits,
      deliveredOrders: row.deliveredOrders,
      lastOrderAt: row.lastOrderAt,
    };
  }

  profile(row: MockCustomer): AdminCustomer {
    const pinned = this.pinned(row.id);
    return {
      ...this.row(row),
      emailVerified: row.emailVerified,
      established: row.established,
      statusChange: this.status(row) === 'active' ? null : row.statusChange,
      limits: customerLimits(DEPOSIT_SETTINGS_DEFAULTS, row.established, row.overrides),
      pinnedNote: pinned && {
        id: pinned.id,
        body: pinned.body,
        pinned: pinned.pinned,
        createdAt: pinned.createdAt,
        archivedAt: pinned.archivedAt,
      },
      counts: {
        deliveredOrders: row.deliveredOrders,
        deliveredTotalUsdUnits: row.deliveredOrders * 990_000,
        refundedOrders: 0,
        creditedDeposits: row.established ? 2 : 0,
        creditedTotalUsdUnits: row.established ? 60 * USD : 0,
        openTickets: this.tickets.filter(
          (ticket) => ticket.customerId === row.id && ticket.status !== 'closed',
        ).length,
        activeSessions: row.sessions.length,
        reservations: row.reservations,
      },
      signals: this.signals(row),
      termsVersion: null,
      privacyVersion: null,
    };
  }

  /** Rule CS1 on the contracts' classifier: an order number finds its customer. */
  private search(q: string | null): MockCustomer[] {
    if (!q) return this.customers;
    const query = classifyCustomerSearch(q);
    switch (query.kind) {
      case 'order': {
        const order = this.orders().find((item) => item.number === query.number);
        return this.customers.filter((row) => row.id === order?.customer.id);
      }
      case 'ticket': {
        const ticket = this.tickets.find((item) => item.number === query.number);
        return this.customers.filter((row) => row.id === ticket?.customerId);
      }
      case 'deposit':
        return [];
      case 'email':
        return this.customers.filter((row) => row.email.startsWith(query.prefix));
      case 'phone':
        return this.customers.filter((row) =>
          query.e164 ? row.phone === query.e164 : row.phone.endsWith(query.digits),
        );
      case 'text': {
        const text = query.text.toLowerCase();
        return this.customers.filter(
          (row) => row.name.toLowerCase().includes(text) || row.email.includes(text),
        );
      }
    }
  }

  private summary(ticket: MockTicket): AdminTicketSummary {
    const owner = this.find(ticket.customerId) as MockCustomer;
    const order = ticket.orderId
      ? this.orders().find((item) => item.id === ticket.orderId)
      : undefined;
    const last = ticket.messages.at(-1) as TicketMessage;
    return {
      id: ticket.id,
      number: ticket.number,
      category: ticket.category,
      order: order ? { id: order.id, number: order.number } : null,
      deposit: null,
      subject: ticket.subject,
      status: ticket.status,
      openedBy: ticket.openedBy,
      lastAuthor: last.author,
      lastMessageAt: last.createdAt,
      closedAt: ticket.closedAt,
      closedBy: ticket.closedBy,
      createdAt: ticket.createdAt,
      customer: { id: owner.id, name: owner.name, email: owner.email, status: this.status(owner) },
    };
  }

  private ticket(ticket: MockTicket): AdminTicket {
    const owner = this.find(ticket.customerId) as MockCustomer;
    const order = ticket.orderId
      ? this.orders().find((item) => item.id === ticket.orderId)
      : undefined;
    return {
      ...this.summary(ticket),
      messages: ticket.messages,
      customer: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        status: this.status(owner),
        phone: owner.phone,
        isTest: owner.isTest,
        marks: this.marks(owner),
      },
      orderSummary: order
        ? {
            id: order.id,
            number: order.number,
            status: order.status,
            productNameAr: order.product.nameAr,
            quantity: order.quantity,
            totalUsdUnits: order.totalUsdUnits,
            createdAt: order.createdAt,
          }
        : null,
      depositSummary: null,
    };
  }

  /** The queue's `open` count (TK13): the navigation badge. */
  openCount() {
    return this.tickets.filter((ticket) => ticket.status === 'open').length;
  }

  answer(method: string, url: URL, body: Body, request: RawRequest): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const sensitive = () =>
      this.reauthenticationRequired() ? error(403, 'REAUTHENTICATION_REQUIRED') : null;

    if (key === 'GET /api/admin/customers') {
      const status = url.searchParams.get('status') ?? 'all';
      const items = this.search(url.searchParams.get('q'))
        .filter((row) =>
          status === 'all' ? true : status === 'test' ? row.isTest : this.status(row) === status,
        )
        .map((row) => this.row(row));
      return ok({ items, nextCursor: null });
    }

    const one = path.match(/^\/api\/admin\/customers\/([^/]+)(\/.*)?$/);
    if (one) {
      const row = this.find(one[1] as string);
      if (!row) return error(404, 'NOT_FOUND');
      return this.answerCustomer(method, one[2] ?? '', row, url, body, sensitive);
    }

    if (key === 'GET /api/admin/support/settings') return ok(this.settings);
    if (key === 'PUT /api/admin/support/settings') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = supportSettingsSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      this.settings = parsed.data;
      return ok(this.settings);
    }
    if (key === 'GET /api/admin/support/tickets') return ok(this.queue(url));
    if (key === 'POST /api/admin/support/tickets') return this.open(request);

    const ticketPath = path.match(/^\/api\/admin\/support\/tickets\/([^/]+)(\/.*)?$/);
    if (ticketPath) {
      const ticket = this.tickets.find((item) => item.id === ticketPath[1]);
      if (!ticket) return error(404, 'NOT_FOUND');
      const rest = ticketPath[2] ?? '';
      if (method === 'GET' && rest === '') return ok(this.ticket(ticket));
      if (method === 'GET' && rest.startsWith('/attachments/')) {
        const fileId = rest.slice('/attachments/'.length);
        const known = ticket.messages.some((item) => item.attachments.includes(fileId));
        return known ? { status: 200, image: true } : error(404, 'NOT_FOUND');
      }
      if (method === 'POST' && rest === '/close') {
        if (ticket.status !== 'closed') {
          ticket.status = 'closed';
          ticket.closedAt = new Date().toISOString();
          ticket.closedBy = 'admin';
          this.record('ticket.closed', 'support_ticket', ticket.id, ticket.customerId);
        }
        return ok(this.ticket(ticket));
      }
      if (method === 'POST' && rest === '/messages') return this.reply(ticket, request);
    }
    return null;
  }

  private queue(url: URL) {
    const status = url.searchParams.get('status') ?? 'open';
    const category = url.searchParams.get('category');
    const customerId = url.searchParams.get('customerId');
    const q = url.searchParams.get('q')?.toUpperCase().replace(/^VT-?/, '');
    const items = this.tickets
      .filter((ticket) => status === 'all' || ticket.status === status)
      .filter((ticket) => !category || ticket.category === category)
      .filter((ticket) => !customerId || ticket.customerId === customerId)
      .filter((ticket) => !q || ticket.number.includes(q))
      .map((ticket) => this.summary(ticket))
      // TK12: the queue oldest customer message first, the other tabs newest activity first.
      .sort((a, b) =>
        status === 'open'
          ? a.lastMessageAt.localeCompare(b.lastMessageAt)
          : b.lastMessageAt.localeCompare(a.lastMessageAt),
      );
    return { items, nextCursor: null, openCount: this.openCount() };
  }

  /** A replayed key answers the first result; with another body, `IDEMPOTENCY_KEY_REUSED`. */
  private replay(request: RawRequest, body: string): Answer | 'new' {
    if (!request.idempotencyKey) return error(400, 'VALIDATION_FAILED');
    const seen = this.ticketKeys.get(request.idempotencyKey);
    if (!seen) return 'new';
    if (seen.body !== body) return error(409, 'IDEMPOTENCY_KEY_REUSED');
    const ticket = this.tickets.find((item) => item.id === seen.ticketId) as MockTicket;
    return ok(this.ticket(ticket));
  }

  private attachments(files: number): string[] {
    return Array.from({ length: files }, () => crypto.randomUUID());
  }

  /** TK5, TK7: a reply, reopening a closed ticket unless its link has another open one. */
  private reply(ticket: MockTicket, request: RawRequest): Answer {
    const { fields, files } = multipart(request);
    const parsed = ticketMessageSchema.safeParse({ body: fields.body ?? '' });
    if (!parsed.success || files > 3) return error(400, 'VALIDATION_FAILED');
    const replayed = this.replay(request, JSON.stringify({ ticket: ticket.id, ...fields, files }));
    if (replayed !== 'new') return replayed;
    const reopening = ticket.status === 'closed';
    if (
      reopening &&
      ticket.orderId &&
      this.tickets.some(
        (other) =>
          other.id !== ticket.id && other.orderId === ticket.orderId && other.status !== 'closed',
      )
    ) {
      return error(409, 'TICKET_ALREADY_OPEN');
    }
    ticket.messages.push({
      id: crypto.randomUUID(),
      author: 'admin',
      body: parsed.data.body,
      attachments: this.attachments(files),
      createdAt: new Date().toISOString(),
    });
    ticket.status = ticketTransition(ticket.status, 'admin_message') ?? ticket.status;
    ticket.closedAt = null;
    ticket.closedBy = null;
    this.ticketKeys.set(request.idempotencyKey as string, {
      body: JSON.stringify({ ticket: ticket.id, ...fields, files }),
      ticketId: ticket.id,
    });
    if (reopening) this.record('ticket.reopened', 'support_ticket', ticket.id, ticket.customerId);
    this.record('ticket.replied', 'support_ticket', ticket.id, ticket.customerId);
    return ok(this.ticket(ticket), 201);
  }

  /** TK2: a ticket opened to a customer, starting `answered`. */
  private open(request: RawRequest): Answer {
    const { fields, files } = multipart(request);
    const parsed = adminCreateTicketSchema.safeParse(fields);
    if (!parsed.success || files > 3) return error(400, 'VALIDATION_FAILED');
    const replayed = this.replay(request, JSON.stringify({ ...fields, files }));
    if (replayed !== 'new') return replayed;
    const input = parsed.data;
    const owner = this.find(input.customerId);
    if (!owner) return error(404, 'NOT_FOUND');
    if (this.status(owner) === 'archived') {
      return error(409, 'CUSTOMER_STATE_INVALID', { status: 'archived' });
    }
    const ownOrder = this.orders().some(
      (order) => order.id === input.orderId && order.customer.id === owner.id,
    );
    if (!ticketLinkValid(input) || (input.orderId && !ownOrder) || input.depositId) {
      return error(400, 'TICKET_LINK_INVALID');
    }
    const open = this.tickets.find(
      (ticket) => input.orderId && ticket.orderId === input.orderId && ticket.status !== 'closed',
    );
    if (open) return error(409, 'TICKET_ALREADY_OPEN', { ticketId: open.id });
    const now = new Date().toISOString();
    const ticket: MockTicket = {
      id: crypto.randomUUID(),
      number: `VT-${['A', 'B', 'C', 'D', 'E', 'F'][this.tickets.length % 6]}2M9KQ`,
      customerId: owner.id,
      category: input.category,
      orderId: input.orderId ?? null,
      depositId: null,
      subject: input.subject,
      status: 'answered',
      openedBy: 'admin',
      closedAt: null,
      closedBy: null,
      createdAt: now,
      messages: [
        {
          id: crypto.randomUUID(),
          author: 'admin',
          body: input.body,
          attachments: this.attachments(files),
          createdAt: now,
        },
      ],
    };
    this.tickets.push(ticket);
    this.ticketKeys.set(request.idempotencyKey as string, {
      body: JSON.stringify({ ...fields, files }),
      ticketId: ticket.id,
    });
    this.record('ticket.opened_by_admin', 'support_ticket', ticket.id, owner.id);
    return ok(this.ticket(ticket), 201);
  }

  private answerCustomer(
    method: string,
    rest: string,
    row: MockCustomer,
    url: URL,
    body: Body,
    sensitive: () => Answer | null,
  ): Answer | null {
    if (method === 'GET') {
      switch (rest) {
        case '':
          return ok(this.profile(row));
        case '/sessions':
          return ok(row.sessions);
        case '/sign-ins':
          return ok({ items: row.signIns, nextCursor: null });
        case '/history':
          return ok({
            items: this.history.filter(
              (entry) => (entry as AuditEntry & { customerId: string }).customerId === row.id,
            ),
            nextCursor: null,
          });
        case '/notes': {
          const archived = url.searchParams.get('archived') === 'true';
          const items = this.notes
            .filter((note) => note.customerId === row.id && !!note.archivedAt === archived)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(({ customerId: _owner, ...note }) => note);
          return ok({ items, nextCursor: null });
        }
      }
      return null;
    }

    if (method === 'POST' && rest === '/notes') {
      const parsed = createCustomerNoteSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (parsed.data.pinned) for (const note of this.notes) note.pinned = false;
      const note = {
        id: crypto.randomUUID(),
        customerId: row.id,
        body: parsed.data.body,
        pinned: parsed.data.pinned,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      this.notes.push(note);
      this.record('customer.note_added', 'customer_note', note.id, row.id);
      const { customerId: _owner, ...shown } = note;
      return ok(shown);
    }
    const noteAction = rest.match(/^\/notes\/([^/]+)\/(pin|unpin|archive)$/);
    if (method === 'POST' && noteAction) {
      const note = this.notes.find(
        (item) => item.id === noteAction[1] && item.customerId === row.id,
      );
      if (!note) return error(404, 'NOT_FOUND');
      if (noteAction[2] === 'pin') {
        for (const other of this.notes) if (other.customerId === row.id) other.pinned = false;
        note.pinned = true;
      } else if (noteAction[2] === 'unpin') {
        note.pinned = false;
      } else {
        note.pinned = false;
        note.archivedAt = new Date().toISOString();
      }
      const actions = {
        pin: 'customer.note_pinned',
        unpin: 'customer.note_unpinned',
        archive: 'customer.note_archived',
      } as const;
      this.record(actions[noteAction[2] as keyof typeof actions], 'customer_note', note.id, row.id);
      const { customerId: _owner, ...shown } = note;
      return ok(shown);
    }

    if (method === 'PUT' && rest === '/limits') {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = updateCustomerLimitsSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      if (this.status(row) === 'archived') {
        return error(409, 'CUSTOMER_STATE_INVALID', { status: 'archived' });
      }
      const { reason, ...overrides } = parsed.data;
      row.overrides = overrides;
      this.record('customer.limits_changed', 'customer', row.id, row.id, reason);
      return ok(customerLimits(DEPOSIT_SETTINGS_DEFAULTS, row.established, row.overrides));
    }

    const change = rest.match(/^\/(freeze|unfreeze|archive|unarchive|sessions\/revoke)$/);
    if (method === 'POST' && change) {
      const refused = sensitive();
      if (refused) return refused;
      const parsed = customerStateChangeSchema.safeParse(body);
      if (!parsed.success) return error(400, 'VALIDATION_FAILED');
      const { reason } = parsed.data;
      const status = this.status(row);
      const invalid = () => error(409, 'CUSTOMER_STATE_INVALID', { status });
      const now = new Date().toISOString();
      switch (change[1]) {
        case 'freeze':
          if (status !== 'active') return invalid();
          row.frozenAt = now;
          row.statusChange = { reason, at: now };
          row.reservations = 0;
          this.record('customer.frozen', 'customer', row.id, row.id, reason);
          break;
        case 'unfreeze':
          if (status !== 'frozen') return invalid();
          row.frozenAt = null;
          row.statusChange = null;
          this.record('customer.unfrozen', 'customer', row.id, row.id, reason);
          break;
        case 'archive': {
          if (status === 'archived') return invalid();
          const blockers = [
            ...(row.balanceUnits !== 0 ? ['balance'] : []),
            ...(row.openOrders ? ['open_orders'] : []),
          ];
          if (blockers.length > 0) return error(409, 'CUSTOMER_NOT_ARCHIVABLE', { blockers });
          row.archivedAt = now;
          row.statusChange = { reason, at: now };
          row.sessions = [];
          this.record('customer.archived', 'customer', row.id, row.id, reason);
          break;
        }
        case 'unarchive':
          if (status !== 'archived') return invalid();
          row.archivedAt = null;
          row.statusChange = row.frozenAt ? row.statusChange : null;
          this.record('customer.unarchived', 'customer', row.id, row.id, reason);
          break;
        default:
          row.sessions = [];
          this.record('customer.sessions_revoked_by_admin', 'customer', row.id, row.id, reason);
      }
      return ok(this.profile(row));
    }
    return null;
  }
}
