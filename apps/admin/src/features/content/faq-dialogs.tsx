import {
  type FaqItem,
  type FaqSection,
  parseRichText,
  saveFaqItemSchema,
  saveFaqSectionSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useSaveItem, useSaveSection } from './content.queries';
import {
  LinkWarnings,
  ProblemList,
  RichPreview,
  refusedFields,
  refusedProblems,
  StorePreview,
} from './content-parts';

/** Add or rename an FAQ section (FQ1, FQ2). */
export function FaqSectionDialog({
  section,
  onDone,
}: {
  /** Null to add one. */
  section: FaqSection | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveSection();
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = saveFaqSectionSchema.safeParse({
      title: String(new FormData(event.currentTarget).get('title') ?? ''),
    });
    setError(parsed.success ? null : t('content.faq.errors.title'));
    if (!parsed.success) return focusInvalid();
    try {
      await save.mutateAsync({ id: section?.id, body: parsed.data });
      onDone();
    } catch (refusal) {
      if (!refusedFields(refusal).has('title')) return setFailure(errorMessage(t, refusal));
      setError(t('content.faq.errors.title'));
      focusInvalid();
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-md">
      <DialogHeader>
        <DialogTitle>
          {section ? t('content.faq.editSection') : t('content.faq.addSection')}
        </DialogTitle>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!error}>
          <FieldLabel>{t('content.faq.sectionTitle')}</FieldLabel>
          <Input name="title" defaultValue={section?.title} maxLength={60} autoComplete="off" />
          <FieldError match={!!error}>{error}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={save.isPending}>
            {t('content.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Add or edit a question (FQ1–FQ3): its section (moving it places it last there), the question
 * and the answer in the limited Markdown with its problems by line and the store preview.
 */
export function FaqItemDialog({
  item,
  sectionId,
  sections,
  onDone,
}: {
  /** Null to add one. */
  item: FaqItem | null;
  sectionId: string;
  /** The unarchived sections it may sit in. */
  sections: FaqSection[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const save = useSaveItem();
  const [section, setSection] = useState(sectionId);
  const [question, setQuestion] = useState(item?.question ?? '');
  const [answer, setAnswer] = useState(item?.answer ?? '');
  const deferredAnswer = useDeferredValue(answer);
  const problems = parseRichText(deferredAnswer).problems;
  const [errors, setErrors] = useState<{ question?: string; answer?: string }>({});
  const [serverProblems, setServerProblems] = useState<typeof problems>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setServerProblems([]);
    const parsed = saveFaqItemSchema.safeParse({ sectionId: section, question, answer });
    const fields = new Set(parsed.error?.issues.map((issue) => String(issue.path[0])));
    setErrors({
      question: fields.has('question') ? t('content.faq.errors.question') : undefined,
      // Markdown problems are listed by line under the field instead.
      answer:
        fields.has('answer') && parseRichText(answer).problems.length === 0
          ? t('content.faq.errors.answer')
          : undefined,
    });
    if (!parsed.success) return focusInvalid();
    try {
      await save.mutateAsync({ id: item?.id, body: parsed.data });
      onDone();
    } catch (refusal) {
      const lines = refusedProblems(refusal, 'answer');
      setServerProblems(lines);
      if (lines.length === 0) setFailure(errorMessage(t, refusal));
      else focusInvalid();
    }
  }

  const shownProblems = problems.length > 0 ? problems : serverProblems;
  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-4xl">
      <DialogHeader>
        <DialogTitle>
          {item ? t('content.faq.editQuestion') : t('content.faq.addQuestion')}
        </DialogTitle>
        <DialogDescription>{t('content.faq.questionDescription')}</DialogDescription>
      </DialogHeader>
      <form
        ref={ref}
        className="grid items-start gap-6 lg:grid-cols-2"
        onSubmit={submit}
        noValidate
      >
        <div className="flex flex-col gap-5">
          <Field>
            <FieldLabel render={<span />}>{t('content.faq.section')}</FieldLabel>
            <Select
              value={section}
              onValueChange={(value) => value && setSection(String(value))}
              items={sections.map((entry) => ({ value: entry.id, label: entry.title }))}
            >
              <SelectTrigger aria-label={t('content.faq.section')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sections.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field invalid={!!errors.question}>
            <FieldLabel>{t('content.faq.question')}</FieldLabel>
            <Input
              value={question}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <FieldError match={!!errors.question}>{errors.question}</FieldError>
          </Field>
          <Field invalid={!!errors.answer || shownProblems.length > 0}>
            <FieldLabel>{t('content.faq.answer')}</FieldLabel>
            <Textarea
              value={answer}
              rows={10}
              dir="rtl"
              className="[unicode-bidi:plaintext]"
              onChange={(event) => setAnswer(event.target.value)}
            />
            <FieldDescription>{t('content.syntax')}</FieldDescription>
            <FieldError match={!!errors.answer}>{errors.answer}</FieldError>
          </Field>
          <ProblemList problems={shownProblems} />
          <LinkWarnings source={deferredAnswer} />
          {failure && <FormAlert>{failure}</FormAlert>}
          <InvalidAlert show={!!(errors.question || errors.answer) || serverProblems.length > 0} />
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {t('content.actions.save')}
            </Button>
          </DialogFooter>
        </div>
        <StorePreview>
          <details open className="m-4 rounded-md border border-border bg-surface px-4">
            <summary className="flex min-h-12 cursor-pointer items-center font-medium">
              {question || t('content.faq.question')}
            </summary>
            <div className="pb-4">
              <RichPreview source={deferredAnswer} />
            </div>
          </details>
        </StorePreview>
      </form>
    </DialogContent>
  );
}
