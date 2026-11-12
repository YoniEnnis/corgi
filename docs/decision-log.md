# Decision log

Short dated notes for decisions that affect the implementation.

## 2026-11-11 — Keep money movement safe for the demo

Use USD, fictional customer data, and sandbox credentials for external integrations. Account funding, outbound payments, and statement imports remain simulated in the app.

## 2026-11-11 — Preserve the internal ledger as the balance source

The append-only ledger remains authoritative for recorded balance and available funds. Card holds and pending outbound payments reduce available funds. Settlement and reversal events are idempotent, and reversals add a linked credit instead of changing the original charge.

## 2026-11-11 — Keep initial funding and reconciliation fixtures simulated

The $500 opening funds and importable external statement records are demo fixtures. This keeps the account workflow runnable without a provider account or real money movement.

## 2026-11-11 — Choose Stripe Payments for the card lifecycle

Stripe Issuing required a Treasury financial account, so use Stripe Payments test mode with manual capture for the card authorization, settlement, and reversal track. The card API lifecycle has been tried locally; signed webhook logging is being configured. Plaid Transfer Sandbox remains the planned outbound ACH integration.

## 2026-11-12 — Bootstrap a Plaid Transfer Sandbox account without Link

Use Plaid's Sandbox-only public-token endpoint with First Platypus Bank and the standard fake user so the interview demo can connect a bank without a separate Link UI. Encrypt the exchanged access token with an app-held AES-256-GCM key before storing it.

## 2026-11-12 — Use Plaid Sandbox ACH credits for outbound payments

When a test bank is linked, create a Plaid ACH credit and let Sandbox events drive the local payment state. The linked test bank is the payout destination and the entered recipient is a memo, because Plaid Transfer credits the linked account. Keep the local ledger authoritative and post its debit only after Plaid reaches `settled`; Sandbox simulations do not move funds. Plaid's credit authorization uses a separate Plaid Ledger or prefunded balance, so the app's simulated account balance does not fund the provider balance.
