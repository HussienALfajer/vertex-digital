import 'i18next';
import type { defaultNS, resources } from './index';

// Type-checks translation keys: t('missing.key') is a compile error.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: (typeof resources)['ar'];
  }
}
