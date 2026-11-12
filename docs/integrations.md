# Integrations and simulated behavior

Last reviewed: 2026-11-12

## Status

Stripe Payments API calls are wired for the card lifecycle and have been tried locally. Signed webhook logging is implemented and needs local listener setup. Plaid Sandbox bank connection, ACH credit creation, and status simulation are wired; local payment verification is still pending.

| Service | Intended use | Status |
| --- | --- | --- |
| Stripe Payments test mode | Card authorization, settlement, and reversal | Implemented; tried locally |
| Plaid Transfer Sandbox | Outbound ACH credits and returns | Implemented; local verification pending |

Use fictional customer data, sandbox credentials, and US dollars. Do not use live credentials.

## Simulated in the app

- Business account creation and incoming funds.
- Card purchase authorization holds, settlement, and reversals.
- Outbound payment status changes are local simulations when no Plaid bank is connected.
- External statement records, reconciliation, and operations corrections.
- Owner and operations demo sign-in.

When Stripe is configured, card authorizations use a test PaymentIntent with manual capture; settlement captures the payment and reversal issues a refund. The internal append-only ledger remains authoritative for recorded balances and available funds. Settlement and reversal event IDs are deduplicated so replaying an event does not post a second ledger entry. Signed webhooks are stored for operations review and do not independently post to the ledger, avoiding a second post for an app-initiated API action.

The Plaid connection endpoint creates a fake First Platypus Bank Item through Plaid Sandbox, exchanges its public token, and stores the access token encrypted in `plaid_connections`. It uses AES-256-GCM and `PLAID_TOKEN_ENCRYPTION_KEY`, which must remain stable anywhere this database branch is used. With a connected sandbox bank, payment creation makes a Plaid ACH credit and stores its authorization and transfer IDs. The Plaid credit goes to the connected test bank account; the recipient text is a payment memo. Plaid credits require available funds in Plaid's separate payout Ledger or prefunded account; the app's demo balance does not fund Plaid's Ledger. The owner view displays the Plaid Ledger's available and pending balances. The local ledger posts the debit when Plaid is simulated to `settled`. Sandbox event simulation does not move money, including within Plaid Sandbox. A declined authorization marks the payment failed and releases its pending reservation.

Required local environment variables are `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`, and `PLAID_TOKEN_ENCRYPTION_KEY`. Never use Production Plaid credentials for this demo. Add the same encryption key to a Vercel environment before deploying any database branch that contains a Plaid connection.

## Local Stripe webhook setup

Add the `whsec_...` value printed by Stripe CLI to `.env.local` as `STRIPE_WEBHOOK_SECRET`, then restart Next.js. Run this in another terminal while the app is running:

```text
stripe listen --events payment_intent.amount_capturable_updated,payment_intent.succeeded,charge.refunded --forward-to http://localhost:3000/api/webhooks/stripe
```

Sign in as the operations reviewer and refresh the **Stripe event deliveries** panel after placing, settling, or reversing a test payment.

## Decision log

See [decision-log.md](./decision-log.md) for dated assumptions and integration choices.
