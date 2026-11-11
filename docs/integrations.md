# Integrations and simulated behavior

Last reviewed: 2026-11-11

## Status

Stripe Payments API calls are wired for the card lifecycle and have been tried locally. Signed webhook logging is implemented and needs local listener setup. Plaid is not connected. Outbound payments and incoming funding remain simulated.

| Service | Intended use | Status |
| --- | --- | --- |
| Stripe Payments test mode | Card authorization, settlement, and reversal | Implemented; local verification pending |
| Plaid Transfer Sandbox | Outbound ACH payments and returns | Planned; not connected |

Use fictional customer data, sandbox credentials, and US dollars. Do not use live credentials.

## Simulated in the app

- Business account creation and incoming funds.
- Card purchase authorization holds, settlement, and reversals.
- Outbound payments and pending, completed, or returned statuses.
- External statement records, reconciliation, and operations corrections.
- Owner and operations demo sign-in.

When Stripe is configured, card authorizations use a test PaymentIntent with manual capture; settlement captures the payment and reversal issues a refund. The internal append-only ledger remains authoritative for recorded balances and available funds. Settlement and reversal event IDs are deduplicated so replaying an event does not post a second ledger entry. Signed webhooks are stored for operations review and do not independently post to the ledger, avoiding a second post for an app-initiated API action.

## Local Stripe webhook setup

Add the `whsec_...` value printed by Stripe CLI to `.env.local` as `STRIPE_WEBHOOK_SECRET`, then restart Next.js. Run this in another terminal while the app is running:

```text
stripe listen --events payment_intent.amount_capturable_updated,payment_intent.succeeded,charge.refunded --forward-to http://localhost:3000/api/webhooks/stripe
```

Sign in as the operations reviewer and refresh the **Stripe event deliveries** panel after placing, settling, or reversing a test payment.

## Decision log

See [decision-log.md](./decision-log.md) for dated assumptions and integration choices.
