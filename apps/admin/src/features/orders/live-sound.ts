import { useEffect, useState } from 'react';

/*
 * S11 rule LR6: a short sound when an order arrives in "review" or "manual", off by default and
 * remembered in this browser. Turning it on is the click browsers require before audio plays; the
 * tone is synthesized, so there is no file to load. Storage may be blocked: it is read in
 * try/catch, and the toggle then lasts until the page closes.
 */

const STORAGE_KEY = 'vd-admin-live-sound';

let context: AudioContext | null = null;

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function store(on: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // The toggle still works for this page.
  }
}

/** Two soft notes, 0.35 seconds in all. */
export function playChime() {
  // Only after the toggle's click created the context: a page never plays sound on its own.
  if (!context) return;
  const start = context.currentTime;
  for (const [index, frequency] of [660, 880].entries()) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = start + index * 0.15;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.2);
  }
}

/** The "صوت" toggle: its state, and the setter that remembers it and unlocks audio. */
export function useLiveSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readStored);
  // Remembered on from an earlier visit: the admin's first click on the page unlocks audio.
  useEffect(() => {
    if (!on || context) return;
    const unlock = () => {
      try {
        context ??= new AudioContext();
        void context.resume();
      } catch {
        // No audio in this browser.
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [on]);
  return [
    on,
    (next) => {
      setOn(next);
      store(next);
      if (!next) return;
      // The click that turns it on lets the page play audio later.
      try {
        context ??= new AudioContext();
        void context.resume();
      } catch {
        // No audio in this browser: the toggle stays, silently.
      }
    },
  ];
}
