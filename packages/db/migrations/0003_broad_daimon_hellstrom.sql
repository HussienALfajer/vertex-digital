ALTER TABLE "staff_accounts" RENAME TO "admin_accounts";--> statement-breakpoint
ALTER TABLE "staff_sessions" RENAME TO "admin_sessions";--> statement-breakpoint
ALTER TABLE "staff_two_factors" RENAME TO "admin_two_factors";--> statement-breakpoint
ALTER TABLE "staff_users" RENAME TO "admin_users";--> statement-breakpoint
ALTER TABLE "staff_verifications" RENAME TO "admin_verifications";--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP CONSTRAINT "staff_sessions_token_unique";--> statement-breakpoint
ALTER TABLE "admin_users" DROP CONSTRAINT "staff_users_email_unique";--> statement-breakpoint
ALTER TABLE "admin_accounts" DROP CONSTRAINT "staff_accounts_user_id_staff_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_sessions" DROP CONSTRAINT "staff_sessions_user_id_staff_users_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_two_factors" DROP CONSTRAINT "staff_two_factors_user_id_staff_users_id_fk";
--> statement-breakpoint
DROP INDEX "staff_accounts_user_id_idx";--> statement-breakpoint
DROP INDEX "staff_sessions_user_id_idx";--> statement-breakpoint
DROP INDEX "staff_two_factors_user_id_idx";--> statement-breakpoint
DROP INDEX "staff_verifications_identifier_idx";--> statement-breakpoint
ALTER TABLE "admin_accounts" ADD CONSTRAINT "admin_accounts_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_two_factors" ADD CONSTRAINT "admin_two_factors_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_accounts_user_id_idx" ON "admin_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_user_id_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_two_factors_user_id_idx" ON "admin_two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_verifications_identifier_idx" ON "admin_verifications" USING btree ("identifier");--> statement-breakpoint
ALTER TABLE "admin_users" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_email_unique" UNIQUE("email");--> statement-breakpoint
DROP TYPE "public"."staff_role";