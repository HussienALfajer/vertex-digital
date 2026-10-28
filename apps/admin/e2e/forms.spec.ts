import type { Locator, Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, PASSWORD, screenshot, test } from './test';

/*
 * Launch hardening (2026-10-14): a refused submit takes the admin to the first invalid field and
 * focuses it (`useFocusInvalid`, packages/ui), with a short alert beside the submit button. The
 * trigger: the deposit settings refused to save with the Sham Cash account empty at the top of a
 * long page, and nothing on screen said why.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

const invalidAlert = (page: Page) =>
  page.getByRole('alert').filter({ hasText: ar.common.invalidFields });

/** The texts of the elements a control's `aria-describedby` names. */
const description = (control: Locator) =>
  control.evaluate((element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' '),
  );

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

test('deposit settings: the empty Sham Cash name is focused, far up the page', async ({
  page,
  admin,
}) => {
  await open(page, admin, '/settings/deposits');
  await expect(page.getByText(ar.depositSettings.fresh.title)).toBeVisible();
  const save = page.getByRole('button', { name: ar.depositSettings.save });
  await save.scrollIntoViewIfNeeded();
  await save.click();

  const name = field(page, ar.depositSettings.account.name);
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(await description(name)).toContain(ar.depositSettings.errors.shamCashAccountName);
  await expect(invalidAlert(page)).toBeVisible();
  expect(admin.calls).not.toContain('PUT /api/admin/deposit-settings');

  // The focus moves once per press: typing elsewhere keeps it there.
  const number = field(page, ar.depositSettings.account.number);
  await number.click();
  await page.keyboard.type('0990');
  await expect(number).toBeFocused();

  // Filled in, the save goes through and the alert leaves.
  await name.fill('متجر تجريبي');
  await number.fill('0990000000');
  await save.click();
  await expect(page.getByText(ar.depositSettings.saved)).toBeVisible();
  await expect(invalidAlert(page)).toBeHidden();
});

test('a dialog form: the re-authentication refuses empty fields, then a wrong code from the server', async ({
  page,
  admin,
}) => {
  admin.reauthenticationRequired = true;
  await open(page, admin, '/settings/deposits');
  await field(page, ar.depositSettings.account.name).fill('متجر تجريبي');
  await field(page, ar.depositSettings.account.number).fill('0990000000');
  await page.getByRole('button', { name: ar.depositSettings.save }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: ar.reauth.title })).toBeVisible();

  // Empty: the password, the dialog's first field, takes the focus (React Hook Form's refusal).
  const password = field(page, ar.reauth.password);
  await dialog.getByRole('button', { name: ar.reauth.submit }).click();
  await expect(password).toBeFocused();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(
    dialog.getByRole('alert').filter({ hasText: ar.common.invalidFields }),
  ).toBeVisible();

  // Server-side refusal (`setError` type 'server'): a wrong code moves the focus to the code.
  await password.fill(PASSWORD);
  const firstSlot = dialog.getByRole('textbox').nth(1);
  await firstSlot.pressSequentially('000000');
  await dialog.getByRole('button', { name: ar.reauth.submit }).click();
  await expect(firstSlot).toBeFocused();
  await expect(firstSlot).toHaveAttribute('aria-invalid', 'true');
  expect(admin.calls).toContain('POST /api/admin/me/reauthenticate');
});

test('a dialog with something typed ignores Escape and a click outside (audit A10-20)', async ({
  page,
  admin,
}) => {
  admin.reauthenticationRequired = true;
  await open(page, admin, '/settings/deposits');
  await field(page, ar.depositSettings.account.name).fill('متجر تجريبي');
  await field(page, ar.depositSettings.account.number).fill('0990000000');
  const save = page.getByRole('button', { name: ar.depositSettings.save });
  await save.click();
  const dialog = page.getByRole('dialog');
  // Nothing typed yet: Escape closes it as before.
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Typed: neither Escape nor a click beside it loses the password.
  await save.click();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await expect(field(page, ar.reauth.password)).toHaveValue(PASSWORD);
  // Its own button still closes it.
  await dialog.getByRole('button', { name: ar.common.close }).click();
  await expect(dialog).toBeHidden();
});

test('a tabbed form: on a phone, a refused title switches back from the preview tab', async ({
  page,
  admin,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, admin, '/content/pages/terms');
  const title = field(page, ar.content.pages.title);
  await title.fill('');
  await page.getByRole('tab', { name: ar.content.pages.previewTab }).click();
  await expect(title).toBeHidden();

  await page.getByRole('button', { name: ar.content.pages.save }).click();
  await expect(page.getByRole('tab', { name: ar.content.pages.editTab })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(invalidAlert(page)).toBeVisible();
  expect(admin.calls).not.toContain('PUT /api/admin/content/pages/terms/draft');
});

// RTL screenshots of the refused deposit settings in both themes (the screen changed).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('refused-form screenshots', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/settings/deposits');
      await page.getByRole('button', { name: ar.depositSettings.save }).click();
      const name = field(page, ar.depositSettings.account.name);
      await expect(name).toBeFocused();
      // The scroll is smooth: wait for it to end.
      await expect(name).toBeInViewport({ ratio: 1 });
      await page.waitForFunction(() => {
        const y = window.scrollY;
        return new Promise((resolve) => setTimeout(() => resolve(window.scrollY === y), 150));
      });
      await screenshot(page, testInfo, `forms-deposit-settings-refused-${colorScheme}`);
      await invalidAlert(page).scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, `forms-deposit-settings-alert-${colorScheme}`);
    });
  });
}
