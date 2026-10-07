import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './locales/ar.json';

export const defaultNS = 'translation';
export const resources = { ar: { translation: ar } } as const;

// V1 is Arabic only (ADR 0012). Adding a language means adding a resource file here.
await i18n.use(initReactI18next).init({
  lng: 'ar',
  fallbackLng: 'ar',
  defaultNS,
  resources,
  interpolation: { escapeValue: false },
});

export default i18n;
