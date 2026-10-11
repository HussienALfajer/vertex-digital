'use client';

import dynamic from 'next/dynamic';
import { type ReactNode, useState } from 'react';
import { t } from '@/lib/i18n';
import { type InstallMode, promptInstall, useInstallMode } from './install';

const InstallSteps = dynamic(() => import('./install-steps').then((m) => m.InstallSteps), {
  ssr: false,
});

/**
 * "ثبّت التطبيق" (IN1): `mode` is null when installing is not possible (the button is hidden),
 * `start` opens Chromium's prompt or the iOS steps, and `steps` is the sheet to render where it
 * outlives the press (outside a menu that closes on it).
 */
export function useInstall(): { mode: InstallMode; start: () => void; steps: ReactNode } {
  const mode = useInstallMode();
  const [stepsOpen, setStepsOpen] = useState(false);
  const [stepsLoaded, setStepsLoaded] = useState(false);
  const start = () => {
    if (mode === 'prompt') return void promptInstall();
    setStepsLoaded(true);
    setStepsOpen(true);
  };
  const steps = stepsLoaded ? <InstallSteps open={stepsOpen} onOpenChange={setStepsOpen} /> : null;
  return { mode, start, steps };
}

/** The footer's entry (IN1). */
export function InstallLink({ className }: { className?: string }) {
  const { mode, start, steps } = useInstall();
  if (!mode) return null;
  return (
    <>
      <button type="button" className={className} onClick={start}>
        {t('pwa.install')}
      </button>
      {steps}
    </>
  );
}
