CREATE TABLE "plaid_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"plaid_account_id" varchar(180) NOT NULL,
	"institution_name" varchar(160) NOT NULL,
	"account_name" varchar(160) NOT NULL,
	"account_mask" varchar(8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plaid_connections_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "plaid_connections" ADD CONSTRAINT "plaid_connections_account_id_business_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."business_accounts"("id") ON DELETE no action ON UPDATE no action;