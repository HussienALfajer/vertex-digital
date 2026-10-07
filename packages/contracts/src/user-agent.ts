/*
 * A short, human description of a browser user agent for session lists and the new sign-in email
 * (rule C10): the browser and the system, in English names the front ends show as they are. Only
 * the families people recognize; anything else is "Unknown".
 */

export interface DeviceDescription {
  browser: string;
  system: string;
}

/** Checked in order: the first match wins (Edge and Opera also say "Chrome", Chrome says "Safari"). */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, 'Android'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

const UNKNOWN = 'Unknown';

const match = (rules: [RegExp, string][], userAgent: string) =>
  rules.find(([pattern]) => pattern.test(userAgent))?.[1] ?? UNKNOWN;

export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
  if (!userAgent) return { browser: UNKNOWN, system: UNKNOWN };
  return { browser: match(BROWSERS, userAgent), system: match(SYSTEMS, userAgent) };
}
