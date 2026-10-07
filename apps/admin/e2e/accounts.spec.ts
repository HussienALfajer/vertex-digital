import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import {
  type AdminApi,
  AUDIT_ENTRIES,
  CUSTOMER_ID,
  expect,
  GENERATED_PASSWORD,
  NEW_PASSWORD,
  PASSWORD,
  screenshot,
  TOTP_CODE,
  test,
} from './test';

/*
 * The admin account and its screens (S01): the forced password change, idle expiry,
 * re-authentication, the account page, the audit log and test customers.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function signIn(page: Page) {
  await field(page, ar.login.email).fill('reem@example.com');
  await field(page, ar.login.password).fill(PASSWORD);
  await page.getByRole('button', { name: ar.login.submit }).click();
}

/** Opens a page of the panel signed in. */
async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

test('a CLI-issued password is changed first, then TOTP is enrolled', async ({ page, admin }) => {
  admin.user.mustChangePassword = true;
  admin.user.twoFactorEnabled = false;
  await page.goto('/login');
  await signIn(page);
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByRole('heading', { name: ar.changePassword.title })).toBeVisible();

  // The panel and the enrolment wait for the password change.
  await page.goto('/');
  await expect(page).toHaveURL(/\/change-password$/);
  await page.goto('/setup-two-factor');
  await expect(page).toHaveURL(/\/change-password$/);

  await field(page, ar.changePassword.current).fill('wrong-password');
  await field(page, ar.changePassword.new).fill(NEW_PASSWORD);
  await field(page, ar.changePassword.confirm).fill('another-new-password');
  await page.getByRole('button', { name: ar.changePassword.submit }).click();
  await expect(page.getByText(ar.changePassword.errors.mismatch)).toBeVisible();

  await field(page, ar.changePassword.confirm).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: ar.changePassword.submit }).click();
  await expect(page.getByText(ar.errors.api.INVALID_PASSWORD)).toBeVisible();

  await field(page, ar.changePassword.current).fill(PASSWORD);
  await page.getByRole('button', { name: ar.changePassword.submit }).click();
  await expect(page).toHaveURL(/\/setup-two-factor$/);
  expect(admin.lastBody('POST /api/admin/auth/change-password')).toEqual({
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
  });
});

test('a short or common new password is refused before any request', async ({ page, admin }) => {
  admin.user.mustChangePassword = true;
  await open(page, admin, '/change-password');
  await field(page, ar.changePassword.current).fill(PASSWORD);
  await field(page, ar.changePassword.new).fill('short-pass');
  await page.getByRole('button', { name: ar.changePassword.submit }).click();
  await expect(page.getByText(ar.changePassword.errors.short)).toBeVisible();
  await field(page, ar.changePassword.new).fill('Contortionist');
  await page.getByRole('button', { name: ar.changePassword.submit }).click();
  await expect(page.getByText(ar.changePassword.errors.common)).toBeVisible();
  expect(admin.calls).not.toContain('POST /api/admin/auth/change-password');
});

test('an idle session returns to sign-in with a notice, then to the same page', async ({
  page,
  admin,
}) => {
  await open(page, admin, '/audit');
  await expect(page.getByRole('heading', { level: 1, name: ar.audit.title })).toBeVisible();
  admin.idleExpired = true;
  // The admin comes back to the tab: nothing is read on its own, so the reason is not lost.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: ar.common.loadMore }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Faudit&reason=idle$/);
  await expect(page.getByText(ar.login.idleNotice)).toBeVisible();

  await signIn(page);
  await page.getByRole('textbox').first().pressSequentially(TOTP_CODE);
  await expect(page).toHaveURL(/\/audit$/);
});

test.describe('audit log', () => {
  test('lists entries newest first, loads more, and opens one in full', async ({ page, admin }) => {
    await open(page, admin, '/audit');
    const rows = page.getByRole('row');
    // The header row, then a page of entries.
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText(ar.audit.actions['customer.profile_updated']);
    await expect(rows.nth(1)).toContainText(
      ar.audit.actorCustomer.replace('{{name}}', 'سارة الأحمد'),
    );
    await page.getByRole('button', { name: ar.common.loadMore }).click();
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(4)).toContainText(ar.audit.actorKinds.cli);
    await expect(page.getByRole('button', { name: ar.common.loadMore })).toHaveCount(0);

    await page.getByRole('button', { name: ar.audit.actions['customer.profile_updated'] }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText(ar.audit.detail.title)).toBeVisible();
    const phoneRow = sheet.getByRole('row', { name: ar.audit.fields.phone });
    await expect(phoneRow).toContainText('+963944123456');
    await expect(phoneRow).toContainText('+963933000111');
    await expect(sheet.getByText('5.0.0.1')).toBeVisible();
  });

  test('filters by actor, action and entity through the URL', async ({ page, admin }) => {
    await open(page, admin, '/audit');
    await page.getByRole('combobox', { name: ar.audit.filters.actorKind }).click();
    await page.getByRole('option', { name: ar.audit.actorKinds.customer }).click();
    await field(page, ar.audit.filters.actorId).fill('not-an-id');
    await page.getByRole('button', { name: ar.audit.filters.apply }).click();
    await expect(page.getByText(ar.audit.filters.invalidId)).toBeVisible();

    await field(page, ar.audit.filters.actorId).fill(CUSTOMER_ID);
    await page.getByRole('combobox', { name: ar.audit.filters.action }).click();
    await page.getByRole('option', { name: ar.audit.actions['customer.profile_updated'] }).click();
    await field(page, ar.audit.filters.entityId).fill(CUSTOMER_ID);
    await page.getByRole('button', { name: ar.audit.filters.apply }).click();
    await expect(page).toHaveURL(/actorKind=customer/);
    await expect(page).toHaveURL(/action=customer\.profile_updated/);
    await expect(page.getByRole('row')).toHaveCount(2);

    const audit = admin.calls.filter((call) => call === 'GET /api/admin/audit');
    expect(audit.length).toBeGreaterThanOrEqual(2);

    await page.getByRole('combobox', { name: ar.audit.filters.action }).click();
    await page.getByRole('option', { name: ar.audit.actions['admin.created'] }).click();
    await page.getByRole('button', { name: ar.audit.filters.apply }).click();
    await expect(page.getByText(ar.audit.emptyTitle)).toBeVisible();
    await page.getByRole('button', { name: ar.audit.filters.clear }).first().click();
    await expect(page).toHaveURL(/\/audit$/);
    await expect(page.getByRole('row')).toHaveCount(AUDIT_ENTRIES.length);
  });
});

test.describe('test customers', () => {
  test('adds one and shows its password once', async ({ page, admin }) => {
    await open(page, admin, '/test-customers');
    await expect(page.getByText(ar.testCustomers.emptyTitle)).toBeVisible();
    await page.getByRole('button', { name: ar.testCustomers.add }).click();
    await field(page, ar.testCustomers.form.name).fill('سارة الأحمد');
    await field(page, ar.testCustomers.form.email).fill('sara@example.com');
    await field(page, ar.testCustomers.form.phone).fill('0944 123 456');
    await page.getByRole('button', { name: ar.testCustomers.form.submit }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ar.testCustomers.password.createdTitle)).toBeVisible();
    await expect(dialog.getByText(GENERATED_PASSWORD)).toBeVisible();
    await expect(dialog.getByText(ar.testCustomers.password.warning)).toBeVisible();
    // The contract sends the phone as E.164.
    expect(admin.lastBody('POST /api/admin/test-customers')).toEqual({
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      phone: '+963944123456',
    });
    await dialog.getByRole('button', { name: ar.testCustomers.password.done }).click();
    await expect(page.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();
    await expect(page.getByText(GENERATED_PASSWORD)).toHaveCount(0);
  });

  test('a taken email is shown under its field', async ({ page, admin }) => {
    admin.testCustomers = [
      {
        id: CUSTOMER_ID,
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        phone: '+963944123456',
        createdAt: '2026-10-08T09:00:00.000Z',
      },
    ];
    await open(page, admin, '/test-customers');
    await page.getByRole('button', { name: ar.testCustomers.add }).click();
    await field(page, ar.testCustomers.form.name).fill('سارة');
    await field(page, ar.testCustomers.form.email).fill('sara@example.com');
    await field(page, ar.testCustomers.form.phone).fill('0944123456');
    await page.getByRole('button', { name: ar.testCustomers.form.submit }).click();
    await expect(page.getByText(ar.errors.api.EMAIL_TAKEN)).toBeVisible();
  });

  test('resets a password after re-authentication, then retries the action', async ({
    page,
    admin,
  }) => {
    admin.testCustomers = [
      {
        id: CUSTOMER_ID,
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        phone: '+963944123456',
        createdAt: '2026-10-08T09:00:00.000Z',
      },
    ];
    admin.reauthenticationRequired = true;
    await open(page, admin, '/test-customers');
    await page
      .getByRole('button', {
        name: ar.testCustomers.reset.label.replace('{{name}}', 'سارة الأحمد'),
      })
      .click();
    await page.getByRole('button', { name: ar.testCustomers.reset.confirm }).click();

    // The API asked for re-authentication: the dialog opens over the action.
    await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
    await field(page, ar.reauth.password).fill(PASSWORD);
    await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially('000000');
    await page.getByRole('button', { name: ar.reauth.submit }).click();
    await expect(page.getByText(ar.errors.api.INVALID_CODE)).toBeVisible();
    await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
    await page.getByRole('button', { name: ar.reauth.submit }).click();

    await expect(
      page.getByRole('heading', { name: ar.testCustomers.password.resetTitle, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(GENERATED_PASSWORD)).toBeVisible();
    expect(
      admin.calls.filter((call) => call.endsWith('/reset-password') && call.startsWith('POST')),
    ).toHaveLength(2);
    expect(admin.lastBody('POST /api/admin/me/reauthenticate')).toEqual({
      password: PASSWORD,
      totpCode: TOTP_CODE,
    });
  });
});

test.describe('account', () => {
  test('regenerates backup codes with the password and shows them once', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/account');
    await field(page, ar.account.backupCodes.password).fill('wrong-password');
    await page.getByRole('button', { name: ar.account.backupCodes.generate }).click();
    await expect(page.getByText(ar.errors.auth.INVALID_PASSWORD)).toBeVisible();
    await field(page, ar.account.backupCodes.password).fill(PASSWORD);
    await page.getByRole('button', { name: ar.account.backupCodes.generate }).click();
    await expect(page.getByText('hjkmn-pqrst')).toBeVisible();
    await expect(page.getByRole('button', { name: ar.account.backupCodes.download })).toBeVisible();
    await page.getByRole('button', { name: ar.account.backupCodes.done }).click();
    await expect(page.getByText('hjkmn-pqrst')).toHaveCount(0);
  });

  test('lists its sessions and signs another one out', async ({ page, admin }) => {
    await open(page, admin, '/account');
    await expect(page.getByText(ar.account.sessions.thisSession)).toBeVisible();
    const other = ar.account.sessions.device
      .replace('{{browser}}', 'Safari')
      .replace('{{system}}', 'iOS');
    await page
      .getByRole('button', { name: ar.account.sessions.signOutLabel.replace('{{device}}', other) })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.account.sessions.signOut })
      .click();
    await expect(page.getByText(other)).toHaveCount(0);
    expect(admin.calls).toContain(
      'DELETE /api/admin/me/sessions/0199a000-0000-7000-8000-0000000000a2',
    );
  });

  test('changes the password from the account page', async ({ page, admin }) => {
    await open(page, admin, '/account');
    await field(page, ar.changePassword.current).fill(PASSWORD);
    await field(page, ar.changePassword.new).fill(NEW_PASSWORD);
    await field(page, ar.changePassword.confirm).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: ar.changePassword.submit }).click();
    await expect(page.getByText(ar.changePassword.changed)).toBeVisible();
  });
});

// RTL screenshots of the S01 screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S01 screenshots', async ({ page, admin }, testInfo) => {
      admin.user.mustChangePassword = true;
      await open(page, admin, '/change-password');
      await expect(page.getByRole('heading', { name: ar.changePassword.title })).toBeVisible();
      await screenshot(page, testInfo, `change-password-${colorScheme}`);
      admin.user.mustChangePassword = false;

      await page.goto('/account');
      await expect(page.getByText(ar.account.sessions.thisSession)).toBeVisible();
      await screenshot(page, testInfo, `account-${colorScheme}`);

      await page.goto('/audit');
      await expect(page.getByRole('row')).toHaveCount(4);
      await screenshot(page, testInfo, `audit-${colorScheme}`);
      await page
        .getByRole('button', { name: ar.audit.actions['customer.profile_updated'] })
        .click();
      await expect(page.getByRole('dialog').getByText(ar.audit.detail.title)).toBeVisible();
      await screenshot(page, testInfo, `audit-detail-${colorScheme}`);

      await page.goto('/test-customers');
      await expect(page.getByText(ar.testCustomers.emptyTitle)).toBeVisible();
      await screenshot(page, testInfo, `test-customers-empty-${colorScheme}`);
      await page.getByRole('button', { name: ar.testCustomers.add }).click();
      await field(page, ar.testCustomers.form.name).fill('سارة الأحمد');
      await field(page, ar.testCustomers.form.email).fill('sara@example.com');
      await field(page, ar.testCustomers.form.phone).fill('0944123456');
      await page.getByRole('button', { name: ar.testCustomers.form.submit }).click();
      await expect(page.getByText(GENERATED_PASSWORD)).toBeVisible();
      await screenshot(page, testInfo, `test-customer-password-${colorScheme}`);
      await page.getByRole('button', { name: ar.testCustomers.password.done }).click();
      await expect(page.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();
      await screenshot(page, testInfo, `test-customers-${colorScheme}`);

      admin.reauthenticationRequired = true;
      await page
        .getByRole('button', {
          name: ar.testCustomers.reset.label.replace('{{name}}', 'سارة الأحمد'),
        })
        .click();
      await page.getByRole('button', { name: ar.testCustomers.reset.confirm }).click();
      await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
      await screenshot(page, testInfo, `reauthentication-${colorScheme}`);

      admin.idleExpired = true;
      await page.goto('/audit');
      await expect(page.getByText(ar.login.idleNotice)).toBeVisible();
      await screenshot(page, testInfo, `login-idle-${colorScheme}`);
    });
  });
}
