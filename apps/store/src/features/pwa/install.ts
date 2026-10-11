import { useSyncExternalStore } from 'react';
import { isAppleMobile, isSafari } from './platform';
import { INSTALL_EVENT } from './registration';

/*
 * Installing the store (S15 IN1): Chromium's kept `beforeinstallprompt` (the layout's
 * REGISTRATION_SCRIPT keeps it on `window.__vdInstall` and announces changes with INSTALL_EVENT),
 * or the Add to Home Screen steps on iOS/iPadOS Safari. Nothing in standalone mode.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

declare global {
  interface Window {
    __vdInstall?: BeforeInstallPromptEvent | null;
  }
}

export type InstallMode = 'prompt' | 'ios' | null;

function standalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

function installMode(): InstallMode {
  if (standalone()) return null;
  if (window.__vdInstall) return 'prompt';
  return isAppleMobile(navigator.userAgent, navigator.maxTouchPoints) &&
    isSafari(navigator.userAgent)
    ? 'ios'
    : null;
}

function subscribe(onChange: () => void) {
  window.addEventListener(INSTALL_EVENT, onChange);
  return () => window.removeEventListener(INSTALL_EVENT, onChange);
}

/** How this browser installs the store, or null (installed, or not possible): IN1. */
export function useInstallMode(): InstallMode {
  return useSyncExternalStore(subscribe, installMode, () => null);
}

/** Chromium's install prompt; the kept event works once, so it is dropped first. */
export async function promptInstall(): Promise<void> {
  const event = window.__vdInstall;
  if (!event) return;
  window.__vdInstall = null;
  window.dispatchEvent(new Event(INSTALL_EVENT));
  await event.prompt().catch(() => {});
}
