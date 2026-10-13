ALTER TABLE "orders" DROP CONSTRAINT "orders_admin_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_admin_check" CHECK (("orders"."placed_by" = 'admin') = ("orders"."admin_purpose" is not null)
        and ("orders"."placed_by" = 'admin') = ("orders"."admin_id" is not null)
        and ("orders"."placed_by" = 'admin') = ("orders"."admin_reason" is not null)
        and ("orders"."customer_id" is null) = coalesce("orders"."admin_purpose" = 'walk_in', false)
        and ("orders"."payer" = 'owner')
          = coalesce("orders"."admin_purpose" in ('walk_in', 'gift', 'compensation'), false)
        and ("orders"."customer_note" is null
          or coalesce("orders"."admin_purpose" in ('gift', 'compensation'), false))
        and ("orders"."placed_by" = 'customer'
          or ("orders"."checkout_id" is null and "orders"."reserved_at" is null and not "orders"."is_gift"))
        and ("orders"."customer_id" is not null or not "orders"."is_test")
        and char_length("orders"."admin_reason") between 5 and 500
        and char_length("orders"."customer_note") between 1 and 300);