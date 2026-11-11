import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "funding",
  "card_settlement",
  "card_reversal",
  "outbound_payment",
  "payment_return",
  "correction",
]);

export const holdStatus = pgEnum("hold_status", ["open", "settled", "released"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "completed", "returned"]);
export const eventStatus = pgEnum("event_status", ["processed", "rejected"]);
export const reconciliationActionType = pgEnum("reconciliation_action_type", ["manual_match", "correction"]);

export const businessAccounts = pgTable("business_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cards = pgTable("cards", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => businessAccounts.id),
  lastFour: varchar("last_four", { length: 4 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("cards_account_id_idx").on(table.accountId)]);

// Amounts are signed integer cents: credits are positive and debits are negative.
// A future availableAt records incoming funds that have posted but cannot be spent yet.
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => businessAccounts.id),
  type: ledgerEntryType("type").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  description: varchar("description", { length: 240 }).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  idempotencyKey: varchar("idempotency_key", { length: 180 }),
  reversalOfId: uuid("reversal_of_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ledger_entries_account_created_idx").on(table.accountId, table.createdAt),
  index("ledger_entries_account_available_idx").on(table.accountId, table.availableAt),
  uniqueIndex("ledger_entries_idempotency_key_unique").on(table.idempotencyKey),
]);

export const cardHolds = pgTable("card_holds", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => businessAccounts.id),
  cardId: uuid("card_id").notNull().references(() => cards.id),
  merchant: varchar("merchant", { length: 160 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  settledAmountCents: bigint("settled_amount_cents", { mode: "number" }),
  settlementEntryId: uuid("settlement_entry_id").references(() => ledgerEntries.id),
  status: holdStatus("status").notNull().default("open"),
  externalAuthId: varchar("external_auth_id", { length: 180 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => [
  index("card_holds_account_status_idx").on(table.accountId, table.status),
]);

export const outboundPayments = pgTable("outbound_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => businessAccounts.id),
  recipient: varchar("recipient", { length: 160 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  status: paymentStatus("status").notNull().default("pending"),
  idempotencyKey: varchar("idempotency_key", { length: 180 }).notNull().unique(),
  completedEntryId: uuid("completed_entry_id").references(() => ledgerEntries.id),
  returnedEntryId: uuid("returned_entry_id").references(() => ledgerEntries.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
}, (table) => [
  index("outbound_payments_account_status_idx").on(table.accountId, table.status),
]);

// One row per provider event. Re-delivery increments deliveryCount without
// creating another ledger entry, making duplicate delivery visible to operations.
export const processedEvents = pgTable("processed_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 80 }).notNull(),
  externalEventId: varchar("external_event_id", { length: 180 }).notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  status: eventStatus("status").notNull().default("processed"),
  deliveryCount: integer("delivery_count").notNull().default(1),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  firstReceivedAt: timestamp("first_received_at", { withTimezone: true }).notNull().defaultNow(),
  lastReceivedAt: timestamp("last_received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("processed_events_provider_external_unique").on(table.provider, table.externalEventId),
]);

export const externalRecords = pgTable("external_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 80 }).notNull(),
  externalRecordId: varchar("external_record_id", { length: 180 }).notNull(),
  accountId: uuid("account_id").references(() => businessAccounts.id),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  description: varchar("description", { length: 240 }).notNull(),
  matchedLedgerEntryId: uuid("matched_ledger_entry_id").references(() => ledgerEntries.id),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("external_records_provider_record_unique").on(table.provider, table.externalRecordId),
  uniqueIndex("external_records_matched_ledger_unique").on(table.matchedLedgerEntryId),
  index("external_records_account_occurred_idx").on(table.accountId, table.occurredAt),
]);

export const reconciliationActions = pgTable("reconciliation_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id").notNull().references(() => businessAccounts.id),
  action: reconciliationActionType("action").notNull(),
  externalRecordId: uuid("external_record_id").references(() => externalRecords.id),
  ledgerEntryId: uuid("ledger_entry_id").references(() => ledgerEntries.id),
  amountCents: bigint("amount_cents", { mode: "number" }),
  reason: varchar("reason", { length: 500 }).notNull(),
  actor: varchar("actor", { length: 120 }).notNull().default("operations reviewer"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("reconciliation_actions_account_created_idx").on(table.accountId, table.createdAt),
]);
