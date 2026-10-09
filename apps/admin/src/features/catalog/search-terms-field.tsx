import { MAX_SEARCH_TERMS } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vertex-digital/ui';
import { XIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addSearchTerm, type SearchTermRefusal } from './search-terms';

/**
 * "كلمات البحث" (S09 rule AD1): chips added with `Enter` and removed with ×, at most 20, stored
 * normalized, so a duplicate after normalization is refused here as the API would refuse it.
 */
export function SearchTermsField({
  terms,
  onChange,
  error,
}: {
  terms: string[];
  onChange: (terms: string[]) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [refusal, setRefusal] = useState<SearchTermRefusal | null>(null);

  function add(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Enter adds a chip; it never submits the game form.
    event.preventDefault();
    const result = addSearchTerm(terms, typed);
    setRefusal(result.refusal);
    if (result.term === null) return;
    onChange([...terms, result.term]);
    setTyped('');
  }

  const message = refusal ? t(`catalog.searchTerms.refused.${refusal}`) : error;
  return (
    <Field invalid={!!message}>
      <FieldLabel>{t('catalog.searchTerms.label')}</FieldLabel>
      {terms.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('catalog.searchTerms.list')}>
          {terms.map((term) => (
            <li key={term}>
              <Badge tone="outline" className="h-8 gap-1 pe-1 text-sm">
                <bdi>{term}</bdi>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="size-6"
                        aria-label={t('catalog.searchTerms.remove', { term })}
                        onClick={() => {
                          setRefusal(null);
                          onChange(terms.filter((other) => other !== term));
                        }}
                      />
                    }
                  >
                    <XIcon />
                  </TooltipTrigger>
                  <TooltipContent>{t('catalog.searchTerms.remove', { term })}</TooltipContent>
                </Tooltip>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={typed}
        maxLength={200}
        autoComplete="off"
        placeholder={t('catalog.searchTerms.placeholder')}
        disabled={terms.length >= MAX_SEARCH_TERMS}
        onChange={(event) => {
          setTyped(event.target.value);
          setRefusal(null);
        }}
        onKeyDown={add}
      />
      <FieldDescription>
        {t('catalog.searchTerms.hint', { count: terms.length, max: MAX_SEARCH_TERMS })}
      </FieldDescription>
      <FieldError match={!!message}>{message}</FieldError>
    </Field>
  );
}
