import { createFileRoute } from '@tanstack/react-router';
import { TelegramPage } from '../../features/telegram/telegram-page';

export const Route = createFileRoute('/_app/settings/telegram')({
  component: TelegramPage,
});
