import { z } from 'zod';
import { fullNameSchema, phoneSchema } from './auth.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';

/*
 * Customers as the admin sees them, owned by the api `auth` module (it owns the customer tables).
 * S01 has test customers only (rules T1–T4); search, freezing and notes arrive with F19 (S12).
 */

/** A test customer created by the admin. */
export const testCustomerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.email(),
    phone: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TestCustomer' });

export type TestCustomer = z.infer<typeof testCustomerSchema>;

export const testCustomerListQuerySchema = cursorQuerySchema.meta({ id: 'TestCustomerListQuery' });

export const testCustomerPageSchema = cursorPageSchema(testCustomerSchema, 'TestCustomerPage');

export type TestCustomerPage = z.infer<typeof testCustomerPageSchema>;

/** `POST /api/admin/test-customers` (rule T1). */
export const createTestCustomerSchema = z
  .object({ name: fullNameSchema, email: z.email().max(254), phone: phoneSchema })
  .meta({ id: 'CreateTestCustomer' });

export type CreateTestCustomer = z.input<typeof createTestCustomerSchema>;

/** A generated password, shown once (rules T1, T2). */
export const generatedPasswordSchema = z
  .object({ password: z.string() })
  .meta({ id: 'GeneratedPassword' });

export type GeneratedPassword = z.infer<typeof generatedPasswordSchema>;

/** A new test customer with its password, shown once (rule T1). */
export const createdTestCustomerSchema = testCustomerSchema
  .extend(generatedPasswordSchema.shape)
  .meta({ id: 'CreatedTestCustomer' });

export type CreatedTestCustomer = z.infer<typeof createdTestCustomerSchema>;
