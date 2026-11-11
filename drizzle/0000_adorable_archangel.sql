CREATE TYPE "public"."event_status" AS ENUM('processed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('open', 'settled', 'released');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('funding', 'card_settlement', 'card_reversal', 'outbound_payment', 'payment_return', 'correction');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'completed', 'returned');--> statement-breakpoint
CREATE TABLE "business_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"merchant" varchar(160) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"settled_amount_cents" bigint,
	"status" "hold_status" DEFAULT 'open' NOT NULL,
	"external_auth_id" varchar(180) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "card_holds_external_auth_id_unique" UNIQUE("external_auth_id")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"last_four" varchar(4) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(80) NOT NULL,
	"external_record_id" varchar(180) NOT NULL,
	"account_id" uuid,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" varchar(240) NOT NULL,
	"matched_ledger_entry_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" varchar(240) NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" varchar(180),
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"recipient" varchar(160) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" varchar(180) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	CONSTRAINT "outbound_payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(80) NOT NULL,
	"external_event_id" varchar(180) NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"status" "event_status" DEFAULT 'processed' NOT NULL,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_holds" ADD CONSTRAINT "card_holds_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_holds" ADD CONSTRAINT "card_holds_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_matched_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("matched_ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_payments" ADD CONSTRAINT "outbound_payments_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_holds_account_status_idx" ON "card_holds" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "cards_account_id_idx" ON "cards" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_records_provider_record_unique" ON "external_records" USING btree ("provider","external_record_id");--> statement-breakpoint
CREATE INDEX "external_records_account_occurred_idx" ON "external_records" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_created_idx" ON "ledger_entries" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_available_idx" ON "ledger_entries" USING btree ("account_id","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_unique" ON "ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_payments_account_status_idx" ON "outbound_payments" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_events_provider_external_unique" ON "processed_events" USING btree ("provider","external_event_id");