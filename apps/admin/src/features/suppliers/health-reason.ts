import { HEALTH_PROBE_REASON } from '@vertex-digital/contracts';

/*
 * A health change's reason (rules H1–H3) as the panel words it. The worker stores the reason
 * `supplierHealth` builds in English for the logs; the panel reads its figures back and shows
 * them in Arabic, and the stored text only for a reason it does not know.
 */

export type HealthReason =
  | { key: 'consecutive'; values: { count: string } }
  | { key: 'fewCalls'; values: { calls: string; min: string } }
  | { key: 'successBelow'; values: { success: string; threshold: string } }
  | { key: 'slow'; values: { p90: string; max: string } }
  | { key: 'success'; values: { success: string } }
  | { key: 'probe'; values: Record<string, never> }
  | { key: 'unknown'; values: { reason: string } };

const PATTERNS: [RegExp, (match: RegExpMatchArray) => HealthReason][] = [
  [/^(\d+) consecutive errors$/, (m) => ({ key: 'consecutive', values: { count: m[1] ?? '' } })],
  [
    /^(\d+) calls < (\d+)$/,
    (m) => ({ key: 'fewCalls', values: { calls: m[1] ?? '', min: m[2] ?? '' } }),
  ],
  [
    /^success (\d+%) < (\d+%)$/,
    (m) => ({ key: 'successBelow', values: { success: m[1] ?? '', threshold: m[2] ?? '' } }),
  ],
  [
    /^p90 (\d+) ms > (\d+) ms$/,
    (m) => ({ key: 'slow', values: { p90: m[1] ?? '', max: m[2] ?? '' } }),
  ],
  [/^success (\d+%)$/, (m) => ({ key: 'success', values: { success: m[1] ?? '' } })],
];

export function healthReason(reason: string): HealthReason {
  if (reason === HEALTH_PROBE_REASON) return { key: 'probe', values: {} };
  for (const [pattern, read] of PATTERNS) {
    const match = reason.match(pattern);
    if (match) return read(match);
  }
  return { key: 'unknown', values: { reason } };
}
