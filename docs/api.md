# API contract

The API is served by Next.js Route Handlers under `/api`. Amounts are integers in cents. Ledger credits are positive and debits are negative. Dates are ISO 8601 strings.

All account and operations routes require a signed-in session. Account and card/payment routes require the `owner` role. Reconciliation and correction routes require the `operations` role. `GET /api/accounts` is available to both roles. See [authentication.md](./authentication.md) for the local demo credentials and Vercel setup.

## Accounts and balances

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Check that the API can reach Neon. |
| `GET /api/accounts` | List business accounts. |
| `POST /api/accounts` | Create an account and its demo card (ending `4821`). Body: `{ "name": "Fieldwork Studio" }`. |
| `GET /api/accounts/{accountId}/balance` | Return recorded and available balances, open card holds, pending payments, and pending incoming funds. |
| `POST /api/accounts/{accountId}/funding` | Add incoming funds. Requires an `Idempotency-Key` header. Body: `{ "amountCents": 50000, "availableAt": "2026-11-11T12:00:00Z", "description": "Opening funds" }`. `availableAt` is optional and defaults to now. |

Available funds are posted funds whose `availableAt` has passed, minus open card holds and pending outbound payments. Recorded balance includes posted ledger entries, including funds that have not become available yet.

## Card activity

| Method and path | Purpose |
|---|---|
| `POST /api/accounts/{accountId}/card-authorizations` | Place a hold. Body: `{ "merchant": "Northstar Coffee Roasters", "amountCents": 8000, "externalAuthId": "auth-001" }`. `cardId` is optional when the account has one active card. |
| `POST /api/accounts/{accountId}/stripe-card-authorizations` | Create a Stripe test-mode PaymentIntent with manual capture and place the matching internal hold. Body: `{ "merchant": "Northstar Coffee Roasters", "amountCents": 8000, "requestId": "<uuid>" }`. Requires a server-side `sk_test_` key. |
| `POST /api/accounts/{accountId}/stripe-card-holds/{holdId}` | Capture or refund a Stripe-backed hold. Body: `{ "action": "capture", "amountCents": 6500 }` or `{ "action": "refund" }`. |
| `POST /api/webhooks/stripe` | Verify a Stripe test-mode webhook and record it idempotently in `processed_events`. Requires `STRIPE_WEBHOOK_SECRET`. |
| `GET /api/operations/provider-events?accountId={accountId}` | List account-scoped Stripe webhook receipts and Plaid Transfer status events for the operations reviewer. |
| `POST /api/accounts/{accountId}/card-settlements` | Settle a hold. Body: `{ "holdId": "...", "amountCents": 6500, "provider": "demo-processor", "externalEventId": "settlement-001" }`. |
| `POST /api/accounts/{accountId}/card-reversals` | Reverse a settled charge in full. Body: `{ "holdId": "...", "provider": "demo-processor", "externalEventId": "reversal-001" }`. |

Settlement and reversal event IDs are unique per provider. Re-delivery returns a duplicate result and increments the event's delivery count; it does not post another ledger entry. A settlement for less than its hold releases the difference. A reversal adds a credit linked to the original settlement.

## Outbound payments

| Method and path | Purpose |
|---|---|
| `GET /api/accounts/{accountId}/plaid-connection` | Return whether Plaid Sandbox is configured and whether this account has a linked test bank account. |
| `POST /api/accounts/{accountId}/plaid-connection` | Create a Plaid Sandbox Item for First Platypus Bank and store its encrypted access token. This does not create a transfer. |
| `GET /api/accounts/{accountId}/payments` | List payments for an account. |
| `POST /api/accounts/{accountId}/payments` | Create a pending payment. Requires `Idempotency-Key`. If a Plaid Sandbox bank is connected, this also creates an ACH credit to that linked test bank account. |
| `POST /api/accounts/{accountId}/payments/{paymentId}/plaid-transfer` | Retry creating the Plaid transfer for an already reserved payment. Plaid authorization and transfer IDs make retries idempotent. |
| `POST /api/accounts/{accountId}/payments/{paymentId}/plaid-events` | Simulate a Plaid Sandbox `posted`, `settled`, or `returned` transfer event; settlement and return update the internal ledger through the normal idempotent payment event route. |
| `POST /api/accounts/{accountId}/payments/{paymentId}/events` | Apply a provider status event. Body: `{ "status": "completed", "provider": "demo-processor", "externalEventId": "payment-001" }`. `status` can be `completed` or `returned`. |

Pending payments reserve available funds. Completion posts the debit and removes the reservation in one transaction. A return after completion posts a linked credit. A payment returned while still pending releases its reservation without posting a debit. A declined Plaid authorization marks the payment failed and releases its reservation. When Plaid is connected, only a Plaid `settled` event completes the internal payment.

## Operations and reconciliation

| Method and path | Purpose |
|---|---|
| `POST /api/operations/external-records` | Import an external record. Body fields: `accountId`, `provider`, `externalRecordId`, signed `amountCents`, `occurredAt`, `description`, and optional `currency` (defaults to `USD`). |
| `GET /api/operations/reconciliation?accountId={accountId}` | Compare imported records with ledger entries and return matches, suggestions, mismatches, external-only records, and internal-only entries. |
| `POST /api/operations/reconciliation/matches` | Manually link a record to a ledger entry. Body: `{ "accountId": "...", "externalRecordId": "...", "ledgerEntryId": "...", "reason": "Confirmed against processor report" }`. |
| `POST /api/operations/corrections` | Add a signed correction entry without changing prior ledger entries. Requires `Idempotency-Key`. Body: `{ "accountId": "...", "amountCents": 125, "reason": "Processor rounding adjustment", "externalRecordId": "..." }`. `externalRecordId` is optional. |

The reconciliation report suggests an exact amount match within 48 hours. It suggests a possible amount mismatch when the normalized descriptions match within 72 hours. Operations can confirm a link manually. If a linked record still differs, a correction is a new ledger entry and the report shows its amount and reason in the audit actions.

## Demo scope

The API has demo authentication and owner/operations role checks, but it is still an interview simulation rather than a real banking service. It models one currency per account and one card; card and payment events are simulated inputs.
