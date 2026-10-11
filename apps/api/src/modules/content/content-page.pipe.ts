import { Injectable, type PipeTransform } from '@nestjs/common';
import { type ContentPage, contentPageSchema } from '@vertex-digital/contracts';
import { refusals } from './content-records.js';

/** A `:page` path segment: one of the four pages, anything else not found (S14 "API"). */
@Injectable()
export class ContentPagePipe implements PipeTransform<string, ContentPage> {
  transform(value: string): ContentPage {
    const page = contentPageSchema.safeParse(value);
    if (!page.success) throw refusals.notFound('page');
    return page.data;
  }
}

/** A `:version` path segment: a positive integer, anything else not found. */
@Injectable()
export class PageVersionPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    if (!/^[1-9]\d{0,8}$/.test(value)) throw refusals.notFound('page version');
    return Number(value);
  }
}
