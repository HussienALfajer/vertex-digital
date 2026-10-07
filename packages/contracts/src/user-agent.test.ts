import { describe, expect, it } from 'vitest';
import { describeUserAgent } from './user-agent.js';

const AGENTS: [userAgent: string, browser: string, system: string][] = [
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Chrome',
    'Windows',
  ],
  [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    'Edge',
    'Windows',
  ],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    'Safari',
    'iOS',
  ],
  [
    'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36',
    'Samsung Internet',
    'Android',
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Firefox',
    'macOS',
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/124.0.0.0',
    'Opera',
    'Linux',
  ],
  [
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'Chrome',
    'ChromeOS',
  ],
  ['curl/8.9.1', 'Unknown', 'Unknown'],
];

describe('describeUserAgent', () => {
  it.each(AGENTS)('%s', (userAgent, browser, system) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser, system });
  });

  it('describes a missing user agent as unknown', () => {
    expect(describeUserAgent(null)).toEqual({ browser: 'Unknown', system: 'Unknown' });
    expect(describeUserAgent(undefined)).toEqual({ browser: 'Unknown', system: 'Unknown' });
  });
});
