CREATE TYPE "public"."reconciliation_action_type" AS ENUM('manual_match', 'correction');--> statement-breakpoint
CREATE TABLE "reconciliation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"action" "reconciliation_action_type" NOT NULL,
	"external_record_id" uuid,
	"ledger_entry_id" uuid,
	"amount_cents" bigint,
	"reason" varchar(500) NOT NULL,
	"actor" varchar(120) DEFAULT 'operations reviewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD COLUMN "completed_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD COLUMN "returned_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "reconciliation_actions" ADD CONSTRAINT "reconciliation_actions_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_actions" ADD CONSTRAINT "reconciliation_actions_external_record_id_external_records_id_fk" FOREIGN KEY ("external_record_id") REFERENCES "public"."external_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_actions" ADD CONSTRAINT "reconciliation_actions_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_actions_account_created_idx" ON "reconciliation_actions" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD CONSTRAINT "outbound_payments_completed_entry_id_ledger_entries_id_fk" FOREIGN KEY ("completed_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD CONSTRAINT "outbound_payments_returned_entry_id_ledger_entries_id_fk" FOREIGN KEY ("returned_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_records_matched_ledger_unique" ON "external_records" USING btree ("matched_ledger_entry_id");