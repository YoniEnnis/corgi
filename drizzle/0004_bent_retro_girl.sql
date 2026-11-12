ALTER TABLE "outbound_payments" ADD COLUMN "plaid_authorization_id" varchar(180);--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD COLUMN "plaid_transfer_id" varchar(180);--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD COLUMN "plaid_status" varchar(40);--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_payments_plaid_transfer_unique" ON "outbound_payments" USING btree ("plaid_transfer_id");