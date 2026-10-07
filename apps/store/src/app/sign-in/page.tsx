import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { SignInForm } from '@/features/auth/sign-in-form';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('signIn.title'),
  robots: { index: false },
};

export default function SignInPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('signIn.title')} description={t('signIn.subtitle')} />
      <SignInForm />
    </div>
  );
}
