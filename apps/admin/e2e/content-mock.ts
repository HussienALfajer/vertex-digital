import {
  ACTIVITY_MINIMUM,
  type AdminActivity,
  ANNOUNCEMENTS_MAX,
  type Announcement,
  BANNERS_ENABLED_MAX,
  type Banner,
  bannerState,
  CONTENT_PAGES,
  type ContentPage,
  FAQ_ITEMS_PER_SECTION_MAX,
  FAQ_SECTIONS_MAX,
  type FaqItem,
  type FaqPublication,
  type FaqSection,
  type PageDraft,
  type PageVersion,
  richTextProblems,
} from '@vertex-digital/contracts';
import type { Answer } from './catalog-mock';

/*
 * Store content (S14) as `/api/admin/content` answers it: the four page drafts with their
 * revisions and versions (PG3–PG6), the FAQ working copy and its publications (FQ1–FQ6), banners
 * (BN3–BN6) and announcements (AN2) with the contracts' `bannerState`, the live activity switch
 * and preview. Every page unpublished and nothing else by default, as the migration seeds it.
 * Uploaded banner images are registered with the catalog mock, whose public route serves them.
 */

type Body = Record<string, unknown> | null;

const error = (status: number, code: string, details?: unknown): Answer => ({
  status,
  json: { statusCode: status, code, message: code, ...(details ? { details } : {}) },
});
const notFound = () => error(404, 'NOT_FOUND');
const stale = () => error(409, 'CONTENT_STALE');

const now = () => new Date().toISOString();
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const id = (n: number) => `0199e000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const TITLES: Record<ContentPage, string> = {
  terms: 'الشروط والأحكام',
  privacy: 'سياسة الخصوصية',
  refund: 'سياسة الاسترداد',
  about: 'من نحن',
};

interface PageRow {
  title: string;
  body: string;
  revision: number;
  updatedAt: string;
  versions: PageVersion[];
}

type SectionRow = Omit<FaqSection, 'position'>;
type ItemRow = Omit<FaqItem, 'position'>;
type BannerRow = Omit<Banner, 'state' | 'position'>;
type AnnouncementRow = Omit<Announcement, 'state'>;

/** Rule MD2's problems in the shape the API refuses them: `[field, line]` and the reason. */
const richTextRefusal = (field: string, source: string): Answer | null => {
  const problems = richTextProblems(source);
  return problems.length > 0
    ? error(
        400,
        'VALIDATION_FAILED',
        problems.map((problem) => ({ path: [field, problem.line], message: problem.reason })),
      )
    : null;
};

/** BN4: a time in the past is refused, unless it is the stored one. */
const pastTime = (
  body: Body,
  stored: { startsAt: string | null; endsAt: string | null } | null,
): Answer | null => {
  for (const key of ['startsAt', 'endsAt'] as const) {
    const value = (body?.[key] as string | null | undefined) ?? null;
    const unchanged =
      value !== null &&
      stored?.[key] != null &&
      new Date(value).getTime() === new Date(stored[key] as string).getTime();
    if (value !== null && new Date(value).getTime() < Date.now() && !unchanged) {
      return error(400, 'VALIDATION_FAILED', [{ path: [key], message: 'past' }]);
    }
  }
  return null;
};

const iso = (value: unknown) => (value == null ? null : new Date(value as string).toISOString());

export class ContentMock {
  pages = new Map<ContentPage, PageRow>(
    CONTENT_PAGES.map((page) => [
      page,
      { title: TITLES[page], body: '', revision: 0, updatedAt: at(600), versions: [] },
    ]),
  );
  sections: SectionRow[] = [];
  items: ItemRow[] = [];
  faqRevision = 0;
  faqChangedAt: string | null = null;
  publications: (FaqPublication & { at: string })[] = [];
  banners: BannerRow[] = [];
  announcements: AnnouncementRow[] = [];
  liveActivityEnabled = true;
  /** The store-wide feed and how many deliveries qualified in the last 24 hours (LA1, LA3). */
  activity: Pick<AdminActivity, 'qualifyingLast24h' | 'items'> = {
    qualifyingLast24h: 2,
    items: [],
  };
  /** What the next banner upload answers: a stored 1600 × 800 image, or a BN2 refusal. */
  nextUpload: 'ok' | 'too_small' | 'ratio' = 'ok';
  private nextId = 1;

  constructor(private readonly registerImage: (id: string) => void) {}

  private newId() {
    this.nextId += 1;
    return id(0x1000 + this.nextId);
  }

  /** Another tab saved the draft (PG3): the editor's next save or publish is stale. */
  saveElsewhere(page: ContentPage) {
    const row = this.pages.get(page) as PageRow;
    row.revision += 1;
    row.updatedAt = now();
  }

  /** A page published as version 1, for the screenshots of a published state. */
  seedPublished(page: ContentPage, body: string) {
    const row = this.pages.get(page) as PageRow;
    row.body = body;
    row.revision = 1;
    row.versions.unshift(this.version(page, row));
  }

  /** Banners for the list's screenshot and the limit: `enabled` of them switched on. */
  seedBanners(count: number, enabled: number) {
    for (let index = 0; index < count; index += 1) {
      const imageFileId = this.newId();
      this.registerImage(imageFileId);
      this.banners.push({
        id: this.newId(),
        imageFileId,
        altText: `عرض رقم ${index + 1}`,
        linkPath: index === 0 ? '/games/pubg-mobile' : null,
        startsAt: index === 1 ? at(-60 * 24) : null,
        endsAt: null,
        enabled: index < enabled,
        archivedAt: null,
        createdAt: at(300),
        updatedAt: at(300),
      });
    }
  }

  /** One announcement, enabled or not. */
  seedAnnouncement(text: string, enabled: boolean) {
    const row: AnnouncementRow = {
      id: this.newId(),
      text,
      linkPath: null,
      tone: 'info',
      startsAt: null,
      endsAt: null,
      enabled,
      revision: 1,
      archivedAt: null,
      createdAt: at(120),
      updatedAt: at(120),
    };
    this.announcements.push(row);
    return row;
  }

  private version(page: ContentPage, row: PageRow): PageVersion {
    return {
      page,
      version: row.versions.length + 1,
      title: row.title,
      body: row.body,
      draftRevision: row.revision,
      publishedAt: now(),
    };
  }

  private summary(page: ContentPage) {
    const row = this.pages.get(page) as PageRow;
    const latest = row.versions[0];
    return {
      page,
      title: row.title,
      revision: row.revision,
      updatedAt: row.updatedAt,
      latestVersion: latest ? { version: latest.version, publishedAt: latest.publishedAt } : null,
      unpublishedChanges: latest
        ? latest.title !== row.title || latest.body !== row.body
        : row.body !== '',
    };
  }

  private draft(page: ContentPage): PageDraft {
    const row = this.pages.get(page) as PageRow;
    return {
      ...this.summary(page),
      body: row.body,
      versions: row.versions.map(({ version, title, publishedAt }) => ({
        version,
        title,
        publishedAt,
      })),
    };
  }

  private workingCopy(archived: boolean) {
    const sections = this.sections
      .filter((section) => archived || !section.archivedAt)
      .map((section, position) => ({
        ...section,
        position,
        items: this.items
          .filter((item) => item.sectionId === section.id && (archived || !item.archivedAt))
          .map((item, index) => ({ ...item, position: index })),
      }));
    const publication = this.publications[0];
    return {
      revision: this.faqRevision,
      changedAt: this.faqChangedAt,
      sections,
      publication: publication
        ? {
            revision: publication.revision,
            publishedAt: publication.publishedAt,
            sections: publication.sections,
            items: publication.items,
          }
        : null,
    };
  }

  private faqChanged() {
    this.faqRevision += 1;
    this.faqChangedAt = now();
  }

  private banner(row: BannerRow): Banner {
    const live = this.banners.filter((banner) => !banner.archivedAt);
    return {
      ...row,
      position: live.indexOf(row) >= 0 ? live.indexOf(row) : live.length,
      state: bannerState(
        {
          enabled: row.enabled,
          archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
          startsAt: row.startsAt ? new Date(row.startsAt) : null,
          endsAt: row.endsAt ? new Date(row.endsAt) : null,
        },
        new Date(),
      ),
    };
  }

  private announcement(row: AnnouncementRow): Announcement {
    return {
      ...row,
      state: bannerState(
        {
          enabled: row.enabled,
          archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
          startsAt: row.startsAt ? new Date(row.startsAt) : null,
          endsAt: row.endsAt ? new Date(row.endsAt) : null,
        },
        new Date(),
      ),
    };
  }

  /** Answers a content route, or null when `path` is not one of them. */
  answer(method: string, url: URL, body: Body): Answer | null {
    const path = url.pathname;
    const key = `${method} ${path}`;
    const archived = url.searchParams.get('archived') === 'true';
    const match = (pattern: RegExp) => pattern.exec(path);

    // Pages ---------------------------------------------------------------------------------
    if (key === 'GET /api/admin/content/pages') {
      return { status: 200, json: CONTENT_PAGES.map((page) => this.summary(page)) };
    }
    const pageMatch = match(/^\/api\/admin\/content\/pages\/([a-z]+)(\/.*)?$/);
    if (pageMatch) {
      const page = pageMatch[1] as ContentPage;
      const row = this.pages.get(page);
      if (!row) return notFound();
      const rest = pageMatch[2] ?? '';
      if (method === 'GET' && rest === '') return { status: 200, json: this.draft(page) };
      const version = /^\/versions\/(\d+)(\/restore)?$/.exec(rest);
      if (version) {
        const found = row.versions.find((entry) => entry.version === Number(version[1]));
        if (!found) return notFound();
        if (method === 'GET' && !version[2]) return { status: 200, json: found };
        if (method === 'POST' && version[2]) {
          if (body?.revision !== row.revision) return stale();
          row.title = found.title;
          row.body = found.body;
          row.revision += 1;
          row.updatedAt = now();
          return { status: 200, json: this.draft(page) };
        }
      }
      if (method === 'PUT' && rest === '/draft') {
        if (body?.revision !== row.revision) return stale();
        const refused = richTextRefusal('body', String(body?.body ?? ''));
        if (refused) return refused;
        row.title = String(body?.title ?? '').trim();
        row.body = String(body?.body ?? '');
        row.revision += 1;
        row.updatedAt = now();
        return { status: 200, json: this.draft(page) };
      }
      if (method === 'POST' && rest === '/publish') {
        if (body?.revision !== row.revision) return stale();
        if (row.body.trim() === '') {
          return error(400, 'VALIDATION_FAILED', [{ path: ['body'], message: 'empty' }]);
        }
        const latest = row.versions[0];
        if (latest && latest.title === row.title && latest.body === row.body) {
          return error(409, 'CONTENT_UNCHANGED');
        }
        const created = this.version(page, row);
        row.versions.unshift(created);
        return { status: 201, json: created };
      }
      return notFound();
    }

    // FAQ -----------------------------------------------------------------------------------
    if (key === 'GET /api/admin/content/faq') {
      return { status: 200, json: this.workingCopy(archived) };
    }
    if (key === 'POST /api/admin/content/faq/sections') {
      if (this.sections.filter((row) => !row.archivedAt).length >= FAQ_SECTIONS_MAX) {
        return error(409, 'CONTENT_LIMIT_REACHED');
      }
      const row: SectionRow = {
        id: this.newId(),
        title: String(body?.title ?? '').trim(),
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.sections.push(row);
      this.faqChanged();
      return { status: 201, json: { ...row, position: this.sections.length - 1 } };
    }
    const section = match(/^\/api\/admin\/content\/faq\/sections\/([^/]+)(\/archive|\/restore)?$/);
    if (section) {
      const row = this.sections.find((entry) => entry.id === section[1]);
      if (!row) return notFound();
      if (method === 'PATCH') row.title = String(body?.title ?? '').trim();
      if (section[2] === '/archive') row.archivedAt ??= now();
      if (section[2] === '/restore') row.archivedAt = null;
      row.updatedAt = now();
      this.faqChanged();
      return { status: 200, json: { ...row, position: 0 } };
    }
    if (
      key === 'POST /api/admin/content/faq/items' ||
      match(/^\/api\/admin\/content\/faq\/items\/[^/]+$/)
    ) {
      const refused = richTextRefusal('answer', String(body?.answer ?? ''));
      if (refused) return refused;
      const sectionId = String(body?.sectionId ?? '');
      const target = this.sections.find((entry) => entry.id === sectionId);
      if (!target) return notFound();
      if (target.archivedAt) return error(409, 'PARENT_ARCHIVED');
      const values = {
        sectionId,
        question: String(body?.question ?? '').trim(),
        answer: String(body?.answer ?? ''),
        updatedAt: now(),
      };
      if (method === 'POST') {
        const count = this.items.filter((item) => item.sectionId === sectionId && !item.archivedAt);
        if (count.length >= FAQ_ITEMS_PER_SECTION_MAX) return error(409, 'CONTENT_LIMIT_REACHED');
        const row: ItemRow = { id: this.newId(), archivedAt: null, createdAt: now(), ...values };
        this.items.push(row);
        this.faqChanged();
        return { status: 201, json: { ...row, position: count.length } };
      }
      const row = this.items.find((entry) => path.endsWith(entry.id));
      if (!row) return notFound();
      // FQ3: moved to another section, it is placed last there.
      if (row.sectionId !== sectionId) {
        this.items = [...this.items.filter((entry) => entry !== row), row];
      }
      Object.assign(row, values);
      this.faqChanged();
      return { status: 200, json: { ...row, position: 0 } };
    }
    const item = match(/^\/api\/admin\/content\/faq\/items\/([^/]+)\/(archive|restore)$/);
    if (item) {
      const row = this.items.find((entry) => entry.id === item[1]);
      if (!row) return notFound();
      if (item[2] === 'restore') {
        if (this.sections.find((entry) => entry.id === row.sectionId)?.archivedAt) {
          return error(409, 'PARENT_ARCHIVED');
        }
        row.archivedAt = null;
      } else {
        row.archivedAt ??= now();
      }
      this.faqChanged();
      return { status: 200, json: { ...row, position: 0 } };
    }
    if (key === 'PUT /api/admin/content/faq/order') {
      const order = (body?.sections ?? []) as { id: string; itemIds: string[] }[];
      const live = this.sections.filter((row) => !row.archivedAt);
      const sameSet = (a: string[], b: string[]) =>
        a.length === b.length && a.every((value) => b.includes(value));
      const valid =
        sameSet(
          order.map((entry) => entry.id),
          live.map((row) => row.id),
        ) &&
        order.every((entry) =>
          sameSet(
            entry.itemIds,
            this.items
              .filter((row) => row.sectionId === entry.id && !row.archivedAt)
              .map((row) => row.id),
          ),
        );
      if (!valid) return error(400, 'VALIDATION_FAILED', [{ path: ['sections'], message: 'set' }]);
      const sectionOrder = order.map((entry) => entry.id);
      const itemOrder = order.flatMap((entry) => entry.itemIds);
      const rank = (list: string[], value: string) =>
        list.includes(value) ? list.indexOf(value) : list.length;
      this.sections.sort((a, b) => rank(sectionOrder, a.id) - rank(sectionOrder, b.id));
      this.items.sort((a, b) => rank(itemOrder, a.id) - rank(itemOrder, b.id));
      this.faqChanged();
      return { status: 200, json: this.workingCopy(false) };
    }
    if (key === 'POST /api/admin/content/faq/publish') {
      if (body?.revision !== this.faqRevision) return stale();
      if (this.publications[0]?.revision === this.faqRevision) {
        return error(409, 'CONTENT_UNCHANGED');
      }
      const snapshot = this.workingCopy(false).sections.filter((entry) => entry.items.length > 0);
      const publication = {
        revision: this.faqRevision,
        publishedAt: now(),
        sections: snapshot.length,
        items: snapshot.reduce((sum, entry) => sum + entry.items.length, 0),
        at: now(),
      };
      this.publications.unshift(publication);
      const { at: _at, ...answer } = publication;
      return { status: 201, json: answer };
    }

    // Banners -------------------------------------------------------------------------------
    if (key === 'POST /api/admin/content/banners/image') {
      if (this.nextUpload !== 'ok') {
        return error(400, 'IMAGE_INVALID', { reason: this.nextUpload });
      }
      const fileId = this.newId();
      this.registerImage(fileId);
      return { status: 201, json: { fileId, width: 1600, height: 800 } };
    }
    if (key === 'GET /api/admin/content/banners') {
      const rows = this.banners.filter((row) => archived || !row.archivedAt);
      return { status: 200, json: rows.map((row) => this.banner(row)) };
    }
    if (key === 'PUT /api/admin/content/banners/order') {
      const ids = (body?.ids ?? []) as string[];
      const live = this.banners.filter((row) => !row.archivedAt);
      if (ids.length !== live.length || !live.every((row) => ids.includes(row.id))) {
        return error(400, 'VALIDATION_FAILED', [{ path: ['ids'], message: 'set' }]);
      }
      this.banners.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return { status: 200, json: this.banners.map((row) => this.banner(row)) };
    }
    if (key === 'POST /api/admin/content/banners') {
      if (this.banners.filter((row) => !row.archivedAt).length >= 20) {
        return error(409, 'CONTENT_LIMIT_REACHED');
      }
      const refused = pastTime(body, null);
      if (refused) return refused;
      const row: BannerRow = {
        id: this.newId(),
        imageFileId: String(body?.imageFileId),
        altText: String(body?.altText ?? '').trim(),
        linkPath: (body?.linkPath as string | null | undefined) ?? null,
        startsAt: iso(body?.startsAt),
        endsAt: iso(body?.endsAt),
        enabled: false,
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.banners.push(row);
      return { status: 201, json: this.banner(row) };
    }
    const banner = match(
      /^\/api\/admin\/content\/banners\/([^/]+)(?:\/(enable|disable|archive|restore))?$/,
    );
    if (banner) {
      const row = this.banners.find((entry) => entry.id === banner[1]);
      if (!row) return notFound();
      switch (banner[2]) {
        case undefined: {
          const refused = pastTime(body, row);
          if (refused) return refused;
          Object.assign(row, {
            imageFileId: String(body?.imageFileId),
            altText: String(body?.altText ?? '').trim(),
            linkPath: (body?.linkPath as string | null | undefined) ?? null,
            startsAt: iso(body?.startsAt),
            endsAt: iso(body?.endsAt),
          });
          break;
        }
        case 'enable': {
          if (row.archivedAt)
            return error(400, 'VALIDATION_FAILED', [{ path: [], message: 'archived' }]);
          const enabled = this.banners.filter((entry) => entry.enabled && !entry.archivedAt);
          if (!row.enabled && enabled.length >= BANNERS_ENABLED_MAX) {
            return error(409, 'CONTENT_LIMIT_REACHED', { limit: BANNERS_ENABLED_MAX });
          }
          row.enabled = true;
          break;
        }
        case 'disable':
          row.enabled = false;
          break;
        case 'archive':
          row.enabled = false;
          row.archivedAt ??= now();
          break;
        case 'restore':
          row.archivedAt = null;
          this.banners = [...this.banners.filter((entry) => entry !== row), row];
          break;
      }
      row.updatedAt = now();
      return { status: 200, json: this.banner(row) };
    }

    // Announcements -------------------------------------------------------------------------
    if (key === 'GET /api/admin/content/announcements') {
      const rows = this.announcements.filter((row) => archived || !row.archivedAt);
      return { status: 200, json: rows.map((row) => this.announcement(row)) };
    }
    if (key === 'POST /api/admin/content/announcements') {
      if (this.announcements.filter((row) => !row.archivedAt).length >= ANNOUNCEMENTS_MAX) {
        return error(409, 'CONTENT_LIMIT_REACHED');
      }
      const refused = pastTime(body, null);
      if (refused) return refused;
      const row: AnnouncementRow = {
        id: this.newId(),
        text: String(body?.text ?? '').trim(),
        linkPath: (body?.linkPath as string | null | undefined) ?? null,
        tone: (body?.tone as AnnouncementRow['tone']) ?? 'info',
        startsAt: iso(body?.startsAt),
        endsAt: iso(body?.endsAt),
        enabled: false,
        revision: 1,
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.announcements.push(row);
      return { status: 201, json: this.announcement(row) };
    }
    const announcement = match(
      /^\/api\/admin\/content\/announcements\/([^/]+)(?:\/(enable|disable|archive|restore))?$/,
    );
    if (announcement) {
      const row = this.announcements.find((entry) => entry.id === announcement[1]);
      if (!row) return notFound();
      let replaced: { id: string; text: string } | null = null;
      switch (announcement[2]) {
        case undefined: {
          const refused = pastTime(body, row);
          if (refused) return refused;
          const text = String(body?.text ?? '').trim();
          const linkPath = (body?.linkPath as string | null | undefined) ?? null;
          const tone = (body?.tone as AnnouncementRow['tone']) ?? 'info';
          // AN4: a changed text, link or tone shows the bar again on devices that closed it.
          if (text !== row.text || linkPath !== row.linkPath || tone !== row.tone)
            row.revision += 1;
          Object.assign(row, {
            text,
            linkPath,
            tone,
            startsAt: iso(body?.startsAt),
            endsAt: iso(body?.endsAt),
          });
          break;
        }
        case 'enable': {
          const current = this.announcements.find(
            (entry) => entry.enabled && !entry.archivedAt && entry !== row,
          );
          if (current) {
            current.enabled = false;
            replaced = { id: current.id, text: current.text };
          }
          row.enabled = true;
          row.updatedAt = now();
          return { status: 200, json: { ...this.announcement(row), replaced } };
        }
        case 'disable':
          row.enabled = false;
          break;
        case 'archive':
          row.enabled = false;
          row.archivedAt ??= now();
          break;
        case 'restore':
          row.archivedAt = null;
          break;
      }
      row.updatedAt = now();
      return { status: 200, json: this.announcement(row) };
    }

    // Live activity -------------------------------------------------------------------------
    if (key === 'GET /api/admin/content/settings') {
      return { status: 200, json: { liveActivityEnabled: this.liveActivityEnabled } };
    }
    if (key === 'PUT /api/admin/content/settings') {
      this.liveActivityEnabled = body?.liveActivityEnabled === true;
      return { status: 200, json: { liveActivityEnabled: this.liveActivityEnabled } };
    }
    if (key === 'GET /api/admin/content/activity') {
      const visible = this.activity.qualifyingLast24h >= ACTIVITY_MINIMUM;
      return {
        status: 200,
        json: {
          enabled: this.liveActivityEnabled,
          qualifyingLast24h: this.activity.qualifyingLast24h,
          minimum: ACTIVITY_MINIMUM,
          visible,
          items: visible ? this.activity.items : [],
        },
      };
    }
    return null;
  }
}
