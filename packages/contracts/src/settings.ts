import { z } from 'zod';
import type { DepositMethod } from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';

/*
 * The store switches (S05 F26, rules SW1–SW10), owned by the api `settings` module. Each switch
 * is a boolean whose current value is its newest `store_switch_changes` row, or its default.
 */

export const STORE_SWITCHES = [
  'registration_open',
  'purchases_stopped',
  'deposits_stopped',
  'sham_cash_paused',
  'usdt_trc20_paused',
  'usdt_bep20_paused',
] as const;

export const storeSwitchSchema = z.enum(STORE_SWITCHES).meta({ id: 'StoreSwitch' });

export type StoreSwitch = z.infer<typeof storeSwitchSchema>;

/** Every switch's value. */
export type StoreSwitchValues = Record<StoreSwitch, boolean>;

/**
 * A switch with no row has its default: registration closed before the pilot (rule SW8), nothing
 * stopped or paused. No migration or seed ever inserts `registration_open = true`.
 */
export const STORE_SWITCH_DEFAULTS: StoreSwitchValues = {
  registration_open: false,
  purchases_stopped: false,
  deposits_stopped: false,
  sham_cash_paused: false,
  usdt_trc20_paused: false,
  usdt_bep20_paused: false,
};

/** Where a change was made: the panel, or the Telegram bot (stops only, rule SW3). */
export const SWITCH_CHANNELS = ['admin', 'telegram'] as const;

export const switchChannelSchema = z.enum(SWITCH_CHANNELS).meta({ id: 'SwitchChannel' });

export type SwitchChannel = z.infer<typeof switchChannelSchema>;

/** The switch that pauses each deposit method (rule SW4). */
export const DEPOSIT_PAUSE_SWITCHES: Record<DepositMethod, StoreSwitch> = {
  sham_cash: 'sham_cash_paused',
  usdt_trc20: 'usdt_trc20_paused',
  usdt_bep20: 'usdt_bep20_paused',
};

/** Why a new deposit of a method is refused with `DEPOSITS_STOPPED` (rule SW4), or null. */
export function depositStopReason(
  values: StoreSwitchValues,
  method: DepositMethod,
): 'emergency' | 'method_paused' | null {
  if (values.deposits_stopped) return 'emergency';
  return values[DEPOSIT_PAUSE_SWITCHES[method]] ? 'method_paused' : null;
}

/** `GET /api/store/status`: what every visitor may know (rules SW8, SW9). */
export const storeStatusSchema = z
  .object({
    registrationOpen: z.boolean(),
    purchasesStopped: z.boolean(),
    depositsStopped: z.boolean(),
  })
  .meta({ id: 'StoreStatus' });

export type StoreStatus = z.infer<typeof storeStatusSchema>;

export function storeStatus(values: StoreSwitchValues): StoreStatus {
  return {
    registrationOpen: values.registration_open,
    purchasesStopped: values.purchases_stopped,
    depositsStopped: values.deposits_stopped,
  };
}

/** `GET /api/admin/switches`: each switch with its default and its newest change, if any. */
export const adminSwitchesSchema = z
  .object({
    switches: z.array(
      z.object({
        switch: storeSwitchSchema,
        value: z.boolean(),
        default: z.boolean(),
        /** The newest change; null while the switch has its default with no row. */
        since: z.iso.datetime().nullable(),
        channel: switchChannelSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'AdminSwitches' });

export type AdminSwitches = z.infer<typeof adminSwitchesSchema>;

/** `POST /api/admin/switches` (rule SW2). */
export const changeSwitchSchema = z
  .object({ switch: storeSwitchSchema, value: z.boolean() })
  .meta({ id: 'ChangeSwitch' });

export type ChangeSwitch = z.infer<typeof changeSwitchSchema>;

/** One row of the history: the switch moved from `!value` to `value`. */
export const switchChangeSchema = z
  .object({
    id: z.uuid(),
    switch: storeSwitchSchema,
    value: z.boolean(),
    channel: switchChannelSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SwitchChange' });

export type SwitchChange = z.infer<typeof switchChangeSchema>;

/** `GET /api/admin/switches/history`: newest first, one switch or all. */
export const switchHistoryQuerySchema = cursorQuerySchema
  .extend({ switch: storeSwitchSchema.optional() })
  .meta({ id: 'SwitchHistoryQuery' });

export type SwitchHistoryQuery = z.infer<typeof switchHistoryQuerySchema>;

export const switchHistoryPageSchema = cursorPageSchema(switchChangeSchema, 'SwitchHistoryPage');

export type SwitchHistoryPage = z.infer<typeof switchHistoryPageSchema>;
