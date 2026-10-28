import { describe, expect, it } from 'vitest';
import { sentryEnvelope } from './report-error';

const DSN = 'https://abc123@o1.ingest.example.com/42';

describe('sentryEnvelope (audit A10-18)', () => {
  it('posts to the project’s envelope endpoint with its key', () => {
    const envelope = sentryEnvelope(
      DSN,
      new Error('GET /api/catalog/storefront answered 503'),
      { path: '/games/pubg-mobile?pack=1&player=51234567', method: 'GET' },
      { routePath: '/games/[slug]', routeType: 'render' },
      new Date('2026-10-28T10:00:00Z'),
    );
    expect(envelope?.url).toBe('https://o1.ingest.example.com/api/42/envelope/');
    expect(envelope?.auth).toContain('sentry_key=abc123');
    const [header, item, event] = (envelope?.body ?? '')
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(header).toMatchObject({ event_id: event.event_id, sent_at: '2026-10-28T10:00:00.000Z' });
    expect(item).toEqual({ type: 'event' });
    expect(event).toMatchObject({
      level: 'error',
      exception: { values: [{ type: 'Error', value: 'GET /api/catalog/storefront answered 503' }] },
      tags: { route: '/games/[slug]', route_type: 'render' },
      // Never the path or its query: a token, a player ID or a search would ride in them.
      request: { method: 'GET', url: '/games/[slug]' },
    });
    expect(envelope?.body).not.toContain('51234567');
  });

  it('sends nothing for a DSN that is not one', () => {
    const request = { path: '/', method: 'GET' };
    const context = { routePath: '/', routeType: 'render' };
    expect(sentryEnvelope('not a url', new Error('x'), request, context)).toBeNull();
    expect(
      sentryEnvelope('https://o1.ingest.example.com/42', new Error('x'), request, context),
    ).toBeNull();
  });
});
