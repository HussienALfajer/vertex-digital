import { z } from 'zod';
import { slugSchema } from './catalog.js';

/*
 * Store content and live activity (S14 F21, F25), owned by the api `content` module: four fixed
 * pages and an FAQ written in a limited Markdown, published as versions and snapshots; home banners
 * and one announcement bar, each scheduled; and the feed of recent real deliveries.
 */

/** S20 MT1: `merchant_terms`, accepted by merchants (shown at `/merchant-terms`). */
export const CONTENT_PAGES = ['terms', 'privacy', 'refund', 'about', 'merchant_terms'] as const;

export const contentPageSchema = z.enum(CONTENT_PAGES).meta({ id: 'ContentPage' });

export type ContentPage = z.infer<typeof contentPageSchema>;

/** A page's store path, its name with hyphens: `merchant_terms` is `/merchant-terms` (A08-33). */
export const contentPagePath = (page: ContentPage): string => `/${page.replaceAll('_', '-')}`;

/** The design system's callout tones (rule AN1). */
export const ANNOUNCEMENT_TONES = ['info', 'warning'] as const;

export const announcementToneSchema = z.enum(ANNOUNCEMENT_TONES).meta({ id: 'AnnouncementTone' });

export type AnnouncementTone = z.infer<typeof announcementToneSchema>;

/* Limits (not editable in the panel, owner 2026-10-11) ------------------------------------- */

export const PAGE_BODY_MAX = 30_000;
export const FAQ_ANSWER_MAX = 3_000;
export const BANNERS_ENABLED_MAX = 5;
export const BANNERS_MAX = 20;
export const ANNOUNCEMENTS_MAX = 20;
export const FAQ_SECTIONS_MAX = 12;
export const FAQ_ITEMS_PER_SECTION_MAX = 30;

/** Banner images (rule BN2): at least 1200 × 600 px, width twice the height within 2%. */
export const BANNER_MIN_WIDTH = 1200;
export const BANNER_MIN_HEIGHT = 600;
export const BANNER_RATIO = 2;
export const BANNER_RATIO_TOLERANCE = 0.02;

/** Live activity (rules LA1–LA4). */
export const ACTIVITY_DELAY_MINUTES = 5;
export const ACTIVITY_ITEMS = 10;
export const ACTIVITY_WINDOW_HOURS = 24;
export const ACTIVITY_MINIMUM = 5;

/* Links (rule MD4) ------------------------------------------------------------------------ */

/**
 * An internal path: `/` but not `//`, at most 200 characters of `A–Z a–z 0–9 - . _ ~ /`, then an
 * optional `#fragment` of `A–Z a–z 0–9 - _`. No scheme, host, query string or `..` segment.
 */
export const linkPathSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9\-._~/]*(?:#[A-Za-z0-9\-_]+)?$/)
  .refine((path) => !/(?:^|\/)\.\.(?:\/|#|$)/.test(path), 'Expected no ".." segment');

/* Limited Markdown (rules MD1–MD5) -------------------------------------------------------- */

export type RichInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: RichInline[] }
  | { type: 'emphasis'; children: RichInline[] }
  | { type: 'link'; href: string; children: RichInline[] }
  | { type: 'break' };

export interface RichListItem {
  children: RichInline[];
  /** A second level; there is no third (rule MD1). */
  list: RichList | null;
}

export interface RichList {
  type: 'list';
  ordered: boolean;
  /** The first number of an ordered list. */
  start: number;
  items: RichListItem[];
}

export type RichBlock =
  | { type: 'paragraph'; children: RichInline[] }
  | { type: 'heading'; level: 2 | 3; id: string; children: RichInline[] }
  | RichList
  | { type: 'quote'; children: RichBlock[] };

/** Why a line is refused (rule MD2); the panel shows each next to its line. */
export const RICH_TEXT_PROBLEMS = [
  'html',
  'image',
  'table',
  'code',
  'rule',
  'link',
  'heading_level',
  'list_depth',
] as const;

export type RichTextProblemReason = (typeof RICH_TEXT_PROBLEMS)[number];

export interface RichTextProblem {
  /** 1-based, in the source as written. */
  line: number;
  reason: RichTextProblemReason;
}

export interface RichText {
  blocks: RichBlock[];
  problems: RichTextProblem[];
}

interface SourceLine {
  text: string;
  line: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_ONE = /^ {0,3}=+[ \t]*$/;
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const TABLE = /^ {0,3}\||^ {0,3}:?-+:?[ \t]*\|/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const INDENTED = /^(?: {4}|\t)/;
/** Any `<` that opens a tag, a comment, a declaration or an autolink. */
const HTML = /<[A-Za-z/!?]/;

/**
 * Parses page bodies and FAQ answers (rules MD1–MD5): the blocks hold only the allowed nodes, and
 * every refused construct is a problem with its line. A refused construct never becomes markup:
 * raw HTML and tables stay plain text, images and code fences are dropped, a refused link keeps its
 * text only. A single new line inside a paragraph is a line break.
 */
export function parseRichText(source: string): RichText {
  const lines = source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }));
  const problems: RichTextProblem[] = lines
    .filter(({ text }) => HTML.test(stripEscapes(text)))
    .map(({ line }) => ({ line, reason: 'html' as const }));
  const headings = { count: 0 };
  const blocks = parseBlocks(lines, problems, headings);
  problems.sort((a, b) => a.line - b.line);
  return { blocks, problems };
}

/** The problems of a source (rule MD2), for the API's refusals. */
export function richTextProblems(source: string): RichTextProblem[] {
  return parseRichText(source).problems;
}

function parseBlocks(
  lines: SourceLine[],
  problems: RichTextProblem[],
  headings: { count: number },
): RichBlock[] {
  const blocks: RichBlock[] = [];
  let paragraph: SourceLine[] = [];
  let index = 0;

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', children: inlineLines(paragraph, problems) });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const current = lines[index] as SourceLine;
    const { text, line } = current;
    if (text.trim() === '') {
      flush();
      index += 1;
      continue;
    }
    if (FENCE.test(text)) {
      problems.push({ line, reason: 'code' });
      flush();
      index += 1;
      continue;
    }
    if (RULE.test(text)) {
      problems.push({ line, reason: 'rule' });
      flush();
      index += 1;
      continue;
    }
    if (paragraph.length > 0 && SETEXT_ONE.test(text)) {
      problems.push({ line, reason: 'heading_level' });
      index += 1;
      continue;
    }
    if (TABLE.test(text)) {
      problems.push({ line, reason: 'table' });
      paragraph.push(current);
      index += 1;
      continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      flush();
      const level = (heading[1] as string).length;
      const content = { text: heading[2] ?? '', line };
      if (level === 2 || level === 3) {
        headings.count += 1;
        blocks.push({
          type: 'heading',
          level,
          id: `section-${headings.count}`,
          children: inlineLines([content], problems),
        });
      } else {
        problems.push({ line, reason: 'heading_level' });
        blocks.push({ type: 'paragraph', children: inlineLines([content], problems) });
      }
      index += 1;
      continue;
    }
    if (QUOTE.test(text)) {
      flush();
      const quoted: SourceLine[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec((lines[index] as SourceLine).text);
        if (!match) break;
        quoted.push({ text: match[1] as string, line: (lines[index] as SourceLine).line });
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseBlocks(quoted, problems, headings) });
      continue;
    }
    if (ITEM.test(text) && (paragraph.length === 0 || startsListAfterText(text))) {
      flush();
      index = parseList(lines, index, problems, blocks);
      continue;
    }
    if (paragraph.length === 0 && INDENTED.test(text)) {
      problems.push({ line, reason: 'code' });
      paragraph.push({ text: text.trim(), line });
      index += 1;
      continue;
    }
    paragraph.push(current);
    index += 1;
  }
  flush();
  return blocks;
}

/** CommonMark: a list interrupts a paragraph only with a bullet or the number 1. */
function startsListAfterText(text: string): boolean {
  const marker = (ITEM.exec(text) as RegExpExecArray)[2] as string;
  return /^(?:[-*+]|1[.)])$/.test(marker);
}

interface OpenItem {
  indent: number;
  item: RichListItem;
  lines: SourceLine[];
}

/**
 * One list from `start`, two levels deep: an item indented by 2 or more spaces past its parent's
 * marker is a child; a deeper one is a `list_depth` problem and kept as text of its parent. A blank
 * line followed by an item of the same list continues it; anything else ends it.
 */
function parseList(
  lines: SourceLine[],
  start: number,
  problems: RichTextProblem[],
  blocks: RichBlock[],
): number {
  const first = ITEM.exec((lines[start] as SourceLine).text) as RegExpExecArray;
  const rootIndent = (first[1] as string).length;
  const root = newList(first[2] as string);
  const stack: OpenItem[] = [];
  let index = start;

  const close = (depth: number) => {
    while (stack.length > depth) {
      const open = stack.pop() as OpenItem;
      open.item.children = inlineLines(open.lines, problems);
    }
  };

  while (index < lines.length) {
    const current = lines[index] as SourceLine;
    if (current.text.trim() === '') {
      const next = lines[index + 1];
      const nextItem = next ? ITEM.exec(next.text) : null;
      if (!nextItem || (nextItem[1] as string).length < rootIndent) break;
      index += 1;
      continue;
    }
    const match = ITEM.exec(current.text);
    if (match) {
      const indent = (match[1] as string).length;
      const marker = match[2] as string;
      const content = { text: match[3] as string, line: current.line };
      const parent = stack[0];
      if (parent === undefined || indent < parent.indent + 2) {
        if (indent < rootIndent || listOf(marker) !== root.ordered) break;
        close(0);
        const item = { children: [], list: null };
        root.items.push(item);
        stack.push({ indent, item, lines: [content] });
      } else if (stack.length === 1 || indent < (stack[1] as OpenItem).indent + 2) {
        close(1);
        if (parent.item.list === null || parent.item.list.ordered !== listOf(marker)) {
          parent.item.list = newList(marker);
        }
        const item = { children: [], list: null };
        parent.item.list.items.push(item);
        stack.push({ indent, item, lines: [content] });
      } else {
        problems.push({ line: current.line, reason: 'list_depth' });
        (stack[stack.length - 1] as OpenItem).lines.push(content);
      }
      index += 1;
      continue;
    }
    if (
      QUOTE.test(current.text) ||
      HEADING.test(current.text) ||
      FENCE.test(current.text) ||
      RULE.test(current.text) ||
      TABLE.test(current.text)
    ) {
      break;
    }
    (stack[stack.length - 1] as OpenItem).lines.push({
      text: current.text.trim(),
      line: current.line,
    });
    index += 1;
  }
  close(0);
  blocks.push(root);
  return index;
}

function listOf(marker: string): boolean {
  return /\d/.test(marker);
}

function newList(marker: string): RichList {
  const ordered = listOf(marker);
  return { type: 'list', ordered, start: ordered ? Number.parseInt(marker, 10) : 1, items: [] };
}

function stripEscapes(text: string): string {
  return text.replace(/\\[\\`*_{}[\]()#+\-.!<>|~]/g, '');
}

/** Lines of one paragraph or item, joined by line breaks. */
function inlineLines(lines: SourceLine[], problems: RichTextProblem[]): RichInline[] {
  const nodes: RichInline[] = [];
  lines.forEach((source, position) => {
    if (position > 0) nodes.push({ type: 'break' });
    nodes.push(...parseInline(source.text.trim(), source.line, problems));
  });
  return mergeText(nodes);
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!<>|~]/;

/**
 * Bold (`**`, `__`), italic (`*`, `_`), links `[text](/path)` and backslash escapes, on one line.
 * An unmatched delimiter stays text. `![…](…)` is an image: dropped, a problem.
 */
function parseInline(text: string, line: number, problems: RichTextProblem[]): RichInline[] {
  const nodes: RichInline[] = [];
  let buffer = '';
  let index = 0;
  const pushText = () => {
    if (buffer !== '') nodes.push({ type: 'text', value: buffer });
    buffer = '';
  };

  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '\\' && next !== undefined && ESCAPABLE.test(next)) {
      buffer += next;
      index += 2;
      continue;
    }
    if (char === '!' && next === '[') {
      const image = linkAt(text, index + 1);
      if (image) {
        problems.push({ line, reason: 'image' });
        index = image.end;
        continue;
      }
    }
    if (char === '[') {
      const link = linkAt(text, index);
      if (link) {
        pushText();
        const children = parseInline(link.label, line, problems);
        if (linkPathSchema.safeParse(link.target).success) {
          nodes.push({ type: 'link', href: link.target, children });
        } else {
          problems.push({ line, reason: 'link' });
          nodes.push(...children);
        }
        index = link.end;
        continue;
      }
    }
    if (char === '*' || char === '_') {
      const double = next === char;
      const delimiter = double ? char + char : char;
      const close = closingDelimiter(text, index + delimiter.length, delimiter);
      if (close !== -1) {
        pushText();
        const children = parseInline(text.slice(index + delimiter.length, close), line, problems);
        nodes.push({ type: double ? 'strong' : 'emphasis', children });
        index = close + delimiter.length;
        continue;
      }
      buffer += delimiter;
      index += delimiter.length;
      continue;
    }
    buffer += char;
    index += 1;
  }
  pushText();
  return nodes;
}

/** The end of a delimiter run that closes `delimiter`, not right after a space; -1 when none. */
function closingDelimiter(text: string, from: number, delimiter: string): number {
  if (from >= text.length || /\s/.test(text[from] as string)) return -1;
  let index = from;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text.startsWith(delimiter, index)) {
      const single = delimiter.length === 1;
      const doubled = text[index + 1] === delimiter;
      if (index > from && !/\s/.test(text[index - 1] as string) && !(single && doubled)) {
        return index;
      }
      index += single && doubled ? 2 : delimiter.length;
      continue;
    }
    index += 1;
  }
  return -1;
}

/** `[label](target)` starting at `start`, or null. Labels hold no brackets (so no link), targets no space. */
function linkAt(
  text: string,
  start: number,
): { label: string; target: string; end: number } | null {
  const match = /^\[([^[\]]*)\]\(\s*([^\s)]*)\s*\)/.exec(text.slice(start));
  if (!match) return null;
  return {
    label: match[1] as string,
    target: match[2] as string,
    end: start + match[0].length,
  };
}

function mergeText(nodes: RichInline[]): RichInline[] {
  const merged: RichInline[] = [];
  for (const node of nodes) {
    const last = merged[merged.length - 1];
    if (node.type === 'text' && last !== undefined && last.type === 'text')
      last.value += node.value;
    else merged.push(node);
  }
  return merged;
}

/**
 * A page body or FAQ answer (rules MD1–MD3): up to `max` characters, stored as written; each
 * problem is an issue at `[line]` (so `details` holds `{ path: [field, line], message: reason }`).
 */
export function richTextSchema(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u)
    .superRefine((source, context) => {
      for (const problem of richTextProblems(source)) {
        context.addIssue({ code: 'custom', path: [problem.line], message: problem.reason });
      }
    });
}

/* Schedules (rules BN4, AN1) -------------------------------------------------------------- */

export const CONTENT_STATES = ['disabled', 'scheduled', 'live', 'ended', 'archived'] as const;

export const contentStateSchema = z.enum(CONTENT_STATES).meta({ id: 'ContentState' });

export type ContentState = z.infer<typeof contentStateSchema>;

export interface Scheduled {
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  archivedAt: Date | null;
}

/** Rule BN4: a banner's state at `now`. */
export function bannerState(row: Scheduled, now: Date): ContentState {
  if (row.archivedAt !== null) return 'archived';
  if (!row.enabled) return 'disabled';
  if (row.endsAt !== null && row.endsAt.getTime() <= now.getTime()) return 'ended';
  if (row.startsAt !== null && row.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

/** Rule AN1: an announcement follows the banners' states. */
export const announcementState: (row: Scheduled, now: Date) => ContentState = bannerState;

/* Live activity (rules LA3–LA5) ----------------------------------------------------------- */

/** Rule LA3: a feed shows only from the minimum of qualifying deliveries. */
export function activityVisible(countLast24h: number): boolean {
  return countLast24h >= ACTIVITY_MINIMUM;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Rule LA4: the time shown, floored to 5 minutes; the exact time never leaves the API. */
export function floorToFiveMinutes(date: Date): Date {
  return new Date(Math.floor(date.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
}

/**
 * Rule LA4: how long ago a floored delivery time was, as the store says it: whole minutes in
 * steps of 5 (at least 5) under an hour, whole hours after; the front ends pick the plural form.
 */
export function activityAge(
  deliveredAt: Date,
  now: Date,
): { unit: 'minutes' | 'hours'; count: number } {
  const minutes = Math.floor((now.getTime() - deliveredAt.getTime()) / 60_000);
  if (minutes < 60) return { unit: 'minutes', count: Math.max(5, minutes - (minutes % 5)) };
  return { unit: 'hours', count: Math.floor(minutes / 60) };
}

export type DurationUnit = 'seconds' | 'minutes' | 'hours';

/**
 * Rule LA5: a delivery duration in whole seconds under a minute, whole minutes under an hour, whole
 * hours after (at least 1 of its unit); the front ends pick the Arabic plural form.
 */
export function formatDeliveryDuration(seconds: number): { unit: DurationUnit; count: number } {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return { unit: 'seconds', count: Math.max(1, whole) };
  if (whole < 3600) return { unit: 'minutes', count: Math.floor(whole / 60) };
  return { unit: 'hours', count: Math.floor(whole / 3600) };
}

/* Inputs ---------------------------------------------------------------------------------- */

/** One line of plain text: trimmed, no control characters. */
const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);

/** A draft's or version's revision as last read (rules PG3, PG5, FQ6). */
const revision = z.int().nonnegative();

/** `PUT /api/admin/content/pages/:page/draft` (rule PG3); an empty body is a valid draft. */
export const savePageDraftSchema = z
  .object({ title: line(2, 80), body: richTextSchema(PAGE_BODY_MAX), revision })
  .meta({ id: 'SavePageDraft' });

export type SavePageDraft = z.input<typeof savePageDraftSchema>;

/** Publishing a page or the FAQ, or restoring a version: the revision previewed (PG5, PG6, FQ6). */
export const contentRevisionSchema = z.object({ revision }).meta({ id: 'ContentRevision' });

export type ContentRevision = z.infer<typeof contentRevisionSchema>;

export const pageParamSchema = z.object({ page: contentPageSchema });

export const pageVersionParamSchema = z.object({
  page: contentPageSchema,
  version: z.coerce.number().int().positive(),
});

/** The admin's archive filter: unarchived rows by default, archived ones too with `true`. */
export const contentListQuerySchema = z
  .object({ archived: z.enum(['true', 'false']).optional() })
  .meta({ id: 'ContentListQuery' });

export type ContentListQuery = z.infer<typeof contentListQuerySchema>;

export const saveFaqSectionSchema = z.object({ title: line(2, 60) }).meta({ id: 'SaveFaqSection' });

export type SaveFaqSection = z.input<typeof saveFaqSectionSchema>;

export const saveFaqItemSchema = z
  .object({
    sectionId: z.uuid(),
    question: line(5, 200),
    answer: richTextSchema(FAQ_ANSWER_MAX).refine(
      (answer) => answer.trim() !== '',
      'Expected an answer',
    ),
  })
  .meta({ id: 'SaveFaqItem' });

export type SaveFaqItem = z.input<typeof saveFaqItemSchema>;

const uniqueIds = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'Expected each id once');

/** Rule FQ4: every unarchived section, and per section every unarchived question, in order. */
export const faqOrderSchema = z
  .object({
    sections: z
      .array(z.object({ id: z.uuid(), itemIds: uniqueIds(FAQ_ITEMS_PER_SECTION_MAX) }))
      .max(FAQ_SECTIONS_MAX)
      .refine(
        (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
        'Expected each section once',
      ),
  })
  .meta({ id: 'FaqOrder' });

export type FaqOrder = z.infer<typeof faqOrderSchema>;

/** Rules BN6: every unarchived banner, in order. */
export const bannerOrderSchema = z
  .object({ ids: uniqueIds(BANNERS_MAX).min(1) })
  .meta({ id: 'BannerOrder' });

export type BannerOrder = z.infer<typeof bannerOrderSchema>;

/** Optional in the body: absent or null is none. */
const optionalLink = linkPathSchema.nullable().optional();
const optionalTime = z.iso.datetime({ offset: true }).nullable().optional();

const schedule = { startsAt: optionalTime, endsAt: optionalTime };

const endsAfterStart = (value: { startsAt?: string | null; endsAt?: string | null }) =>
  value.startsAt == null ||
  value.endsAt == null ||
  new Date(value.endsAt).getTime() > new Date(value.startsAt).getTime();

/** `POST` and `PATCH /api/admin/content/banners` (rules BN1, BN4): the whole banner each time. */
export const bannerInputSchema = z
  .object({
    imageFileId: z.uuid(),
    altText: line(2, 120),
    linkPath: optionalLink,
    ...schedule,
  })
  .refine(endsAfterStart, { message: 'Expected the end after the start', path: ['endsAt'] })
  .meta({ id: 'BannerInput' });

export type BannerInput = z.input<typeof bannerInputSchema>;

/** `POST` and `PATCH /api/admin/content/announcements` (rules AN1, BN4): plain text, no Markdown. */
export const announcementInputSchema = z
  .object({
    text: line(5, 140),
    linkPath: optionalLink,
    tone: announcementToneSchema.default('info'),
    ...schedule,
  })
  .refine(endsAfterStart, { message: 'Expected the end after the start', path: ['endsAt'] })
  .meta({ id: 'AnnouncementInput' });

export type AnnouncementInput = z.input<typeof announcementInputSchema>;

export const contentSettingsSchema = z
  .object({ liveActivityEnabled: z.boolean() })
  .meta({ id: 'ContentSettings' });

export type ContentSettings = z.infer<typeof contentSettingsSchema>;

/** `GET /api/content/activity`: the store-wide feed, or one game's. */
export const activityQuerySchema = z
  .object({ game: slugSchema.optional() })
  .meta({ id: 'ActivityQuery' });

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

/* Admin outputs --------------------------------------------------------------------------- */

const versionSummary = z.object({
  version: z.int().positive(),
  title: z.string(),
  publishedAt: z.iso.datetime(),
});

/** One row of `GET /api/admin/content/pages`. */
export const pageSummarySchema = z
  .object({
    page: contentPageSchema,
    title: z.string(),
    revision,
    updatedAt: z.iso.datetime(),
    latestVersion: versionSummary.omit({ title: true }).nullable(),
    /** The draft differs from the newest version, or nothing is published yet and the body is set. */
    unpublishedChanges: z.boolean(),
  })
  .meta({ id: 'PageSummary' });

export type PageSummary = z.infer<typeof pageSummarySchema>;

/** A page's draft with its versions, newest first. */
export const pageDraftSchema = pageSummarySchema
  .extend({ body: z.string(), versions: z.array(versionSummary) })
  .meta({ id: 'PageDraft' });

export type PageDraft = z.infer<typeof pageDraftSchema>;

export const pageVersionSchema = z
  .object({
    page: contentPageSchema,
    version: z.int().positive(),
    title: z.string(),
    body: z.string(),
    draftRevision: revision,
    publishedAt: z.iso.datetime(),
  })
  .meta({ id: 'PageVersion' });

export type PageVersion = z.infer<typeof pageVersionSchema>;

const row = {
  id: z.uuid(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

const record = { ...row, position: z.int() };

export const faqItemSchema = z
  .object({ ...record, sectionId: z.uuid(), question: z.string(), answer: z.string() })
  .meta({ id: 'FaqItem' });

export type FaqItem = z.infer<typeof faqItemSchema>;

export const faqSectionSchema = z
  .object({ ...record, title: z.string() })
  .meta({ id: 'FaqSection' });

export type FaqSection = z.infer<typeof faqSectionSchema>;

/** A publication of the FAQ (rule FQ6), with what it holds. */
export const faqPublicationSchema = z
  .object({
    revision,
    publishedAt: z.iso.datetime(),
    sections: z.int().nonnegative(),
    items: z.int().nonnegative(),
  })
  .meta({ id: 'FaqPublication' });

export type FaqPublication = z.infer<typeof faqPublicationSchema>;

/** `GET /api/admin/content/faq`: the working copy, in order (rules FQ1, FQ6). */
export const faqWorkingCopySchema = z
  .object({
    revision,
    /** The newest change to the working copy; null before the first. */
    changedAt: z.iso.datetime().nullable(),
    sections: z.array(faqSectionSchema.extend({ items: z.array(faqItemSchema) })),
    publication: faqPublicationSchema.nullable(),
  })
  .meta({ id: 'FaqWorkingCopy' });

export type FaqWorkingCopy = z.infer<typeof faqWorkingCopySchema>;

/** `POST /api/admin/content/banners/image` (rule BN2). */
export const bannerImageSchema = z
  .object({ fileId: z.uuid(), width: z.int().positive(), height: z.int().positive() })
  .meta({ id: 'BannerImage' });

export type BannerImage = z.infer<typeof bannerImageSchema>;

const scheduled = {
  ...row,
  linkPath: z.string().nullable(),
  startsAt: z.iso.datetime().nullable(),
  endsAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  state: contentStateSchema,
};

export const bannerSchema = z
  .object({ ...scheduled, position: z.int(), imageFileId: z.uuid(), altText: z.string() })
  .meta({ id: 'Banner' });

export type Banner = z.infer<typeof bannerSchema>;

export const announcementSchema = z
  .object({
    ...scheduled,
    text: z.string(),
    tone: announcementToneSchema,
    revision: z.int().positive(),
  })
  .meta({ id: 'Announcement' });

export type Announcement = z.infer<typeof announcementSchema>;

/** `POST …/announcements/:id/enable` (rule AN2): the one it disabled, if any. */
export const enabledAnnouncementSchema = announcementSchema
  .extend({ replaced: z.object({ id: z.uuid(), text: z.string() }).nullable() })
  .meta({ id: 'EnabledAnnouncement' });

export type EnabledAnnouncement = z.infer<typeof enabledAnnouncementSchema>;

/* Public outputs (rule CP3: only what the store shows) ------------------------------------ */

/** One delivery of the feed (rule LA2): nothing about the customer or the order. */
export const activityItemSchema = z
  .object({
    gameSlug: z.string(),
    gameNameAr: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
    durationSeconds: z.int().nonnegative(),
    /** Floored to 5 minutes (rule LA4). */
    deliveredAt: z.iso.datetime(),
  })
  .meta({ id: 'ActivityItem' });

export type ActivityItem = z.infer<typeof activityItemSchema>;

/** Empty below the minimum (rule LA3) or while switched off (rule LA6). */
export const activitySchema = z
  .object({ items: z.array(activityItemSchema).max(ACTIVITY_ITEMS) })
  .meta({ id: 'Activity' });

export type Activity = z.infer<typeof activitySchema>;

/** `GET /api/admin/content/activity`: the store-wide feed as the store would show it, ignoring the switch. */
export const adminActivitySchema = activitySchema
  .extend({
    enabled: z.boolean(),
    qualifyingLast24h: z.int().nonnegative(),
    minimum: z.int().positive(),
    visible: z.boolean(),
  })
  .meta({ id: 'AdminActivity' });

export type AdminActivity = z.infer<typeof adminActivitySchema>;

/** `GET /api/content/site`: what every store page may show. */
export const siteContentSchema = z
  .object({
    announcement: z
      .object({
        id: z.uuid(),
        revision: z.int().positive(),
        text: z.string(),
        linkPath: z.string().nullable(),
        tone: announcementToneSchema,
      })
      .nullable(),
    banners: z
      .array(
        z.object({
          id: z.uuid(),
          imageId: z.uuid(),
          altText: z.string(),
          linkPath: z.string().nullable(),
        }),
      )
      .max(BANNERS_ENABLED_MAX),
    pages: z.array(
      z.object({ page: contentPageSchema, title: z.string(), updatedAt: z.iso.datetime() }),
    ),
    faqPublished: z.boolean(),
    /** Rule C16: the sign-up switch, for the header in the cached HTML. */
    registrationOpen: z.boolean(),
  })
  .meta({ id: 'SiteContent' });

export type SiteContent = z.infer<typeof siteContentSchema>;

/** `GET /api/content/pages/:page`: the newest version (rule PG2). */
export const publishedPageSchema = z
  .object({
    page: contentPageSchema,
    title: z.string(),
    body: z.string(),
    version: z.int().positive(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'PublishedPage' });

export type PublishedPage = z.infer<typeof publishedPageSchema>;

/** The FAQ snapshot as stored and served (rule FQ5). */
export const faqSnapshotSchema = z.array(
  z.object({
    id: z.uuid(),
    title: z.string(),
    items: z.array(z.object({ id: z.uuid(), question: z.string(), answer: z.string() })),
  }),
);

export type FaqSnapshot = z.infer<typeof faqSnapshotSchema>;

/** `GET /api/content/faq`. */
export const publishedFaqSchema = z
  .object({ sections: faqSnapshotSchema, updatedAt: z.iso.datetime() })
  .meta({ id: 'PublishedFaq' });

export type PublishedFaq = z.infer<typeof publishedFaqSchema>;

/** S12 TA3: a version a customer accepted at sign-up, on the admin profile. */
export const acceptedVersionSchema = z
  .object({ version: z.int().positive(), publishedAt: z.iso.datetime() })
  .meta({ id: 'AcceptedVersion' });

export type AcceptedVersion = z.infer<typeof acceptedVersionSchema>;
