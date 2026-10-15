ALTER TABLE "store_switch_changes" ALTER COLUMN "switch" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."store_switch";--> statement-breakpoint
CREATE TYPE "public"."store_switch" AS ENUM('registration_open', 'purchases_stopped', 'deposits_stopped', 'sham_cash_paused', 'usdt_trc20_paused', 'usdt_bep20_paused', 'wdgzone_paused', 'manual_paused', 'fake_paused');--> statement-breakpoint
ALTER TABLE "store_switch_changes" ALTER COLUMN "switch" SET DATA TYPE "public"."store_switch" USING "switch"::"public"."store_switch";--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."supplier_code";--> statement-breakpoint
CREATE TYPE "public"."supplier_code" AS ENUM('wdgzone', 'manual', 'fake');--> statement-breakpoint
ALTER TABLE "suppliers" ALTER COLUMN "code" SET DATA TYPE "public"."supplier_code" USING "code"::"public"."supplier_code";