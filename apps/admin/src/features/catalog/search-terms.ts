import { MAX_SEARCH_TERMS, normalizeSearchText } from '@vertex-digital/contracts';

const MAX_TERM_LENGTH = 40;

export type SearchTermRefusal = 'empty' | 'tooLong' | 'duplicate' | 'full';

/** Why `typed` cannot join `terms` (rule AD1), or null with its normalized form (rule SR1). */
export function addSearchTerm(
  terms: readonly string[],
  typed: string,
): { term: string; refusal: null } | { term: null; refusal: SearchTermRefusal } {
  const term = normalizeSearchText(typed);
  if (term === '') return { term: null, refusal: 'empty' };
  if (term.length > MAX_TERM_LENGTH) return { term: null, refusal: 'tooLong' };
  if (terms.includes(term)) return { term: null, refusal: 'duplicate' };
  if (terms.length >= MAX_SEARCH_TERMS) return { term: null, refusal: 'full' };
  return { term, refusal: null };
}
