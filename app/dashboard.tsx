"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type Account = { id: string; name: string; currency: string };
type Balance = {
  recordedBalanceCents: number;
  availableBalanceCents: number;
  pendingIncomingCents: number;
  cardHoldsCents: number;
  pendingPaymentsCents: number;
};
type LedgerEntry = {
  id: string;
  type: string;
  amountCents: number;
  description: string;
  createdAt: string;
  reversalOfId: string | null;
};
type CardHold = {
  id: string;
  merchant: string;
  amountCents: number;
  settledAmountCents: number | null;
  status: "open" | "settled" | "released";
  reversed: boolean;
  createdAt: string;
};
type Payment = {
  id: string;
  recipient: string;
  amountCents: number;
  status: "pending" | "completed" | "returned";
  createdAt: string;
};
type SettlementEvent = { holdId: string; amountCents: number; provider: string; externalEventId: string };
type ExternalRecord = {
  id: string;
  provider: string;
  externalRecordId: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
  description: string;
};
type ReconciliationAction = { id: string; action: string; reason: string; amountCents: number | null; createdAt: string };
type ReconciliationRow = {
  externalRecord: ExternalRecord;
  status: string;
  ledgerEntry?: LedgerEntry;
  candidateLedgerEntry?: LedgerEntry;
  differenceCents?: number;
  actions?: ReconciliationAction[];
};
type Reconciliation = {
  summary: { externalRecords: number; matched: number; mismatched: number; matchSuggested: number; externalOnly: number; internalOnly: number };
  externalRecords: ReconciliationRow[];
  internalOnly: LedgerEntry[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

function toCents(value: string, allowNegative = false) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.round(amount * 100) === 0 || (!allowNegative && amount < 0)) {
    throw new Error(allowNegative ? "Enter a non-zero dollar amount." : "Enter an amount greater than zero.");
  }
  return Math.round(amount * 100);
}

function dollars(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [holds, setHolds] = useState<CardHold[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [view, setView] = useState<"owner" | "operations">("owner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settlementAmounts, setSettlementAmounts] = useState<Record<string, string>>({});
  const [lastSettlementEvent, setLastSettlementEvent] = useState<SettlementEvent | null>(null);

  const account = accounts.find((item) => item.id === accountId) ?? null;

  async function loadAccounts() {
    try {
      const data = await api<{ accounts: Account[] }>("/api/accounts");
      setAccounts(data.accounts);
      setAccountId((current) => current || data.accounts[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load accounts.");
    }
  }

  async function refreshAccountData(id = accountId) {
    if (!id) return;
    const [balanceData, activityData] = await Promise.all([
      api<{ balances: Balance }>(`/api/accounts/${id}/balance`),
      api<{ entries: LedgerEntry[]; cardHolds: CardHold[]; payments: Payment[] }>(`/api/accounts/${id}/activity`),
    ]);
    setBalance(balanceData.balances);
    setEntries(activityData.entries);
    setHolds(activityData.cardHolds);
    setPayments(activityData.payments);
  }

  async function refreshReconciliation(id = accountId) {
    if (!id) return;
    const data = await api<Reconciliation>(`/api/operations/reconciliation?accountId=${id}`);
    setReconciliation(data);
  }

  useEffect(() => { void loadAccounts(); }, []);

  useEffect(() => {
    if (!accountId) {
      setBalance(null);
      setEntries([]);
      setHolds([]);
      setPayments([]);
      setReconciliation(null);
      return;
    }
    void refreshAccountData().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load account."));
    void refreshReconciliation().catch(() => setReconciliation(null));
  }, [accountId]);

  async function refreshAll() {
    await refreshAccountData();
    await refreshReconciliation();
  }

  async function submit(action: () => Promise<void>, successMessage: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(successMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "");
    await submit(async () => {
      const data = await api<{ account: Account }>("/api/accounts", { method: "POST", body: JSON.stringify({ name }) });
      setAccounts((current) => [...current, data.account]);
      setAccountId(data.account.id);
      formElement.reset();
    }, "Business account created.");
  }

  async function addFunds(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const amountCents = toCents(String(form.get("amount") ?? ""));
    const description = String(form.get("description") ?? "Incoming funds");
    await submit(async () => {
      await api(`/api/accounts/${accountId}/funding`, {
        method: "POST",
        headers: { "Idempotency-Key": `funding-${crypto.randomUUID()}` },
        body: JSON.stringify({ amountCents, description }),
      });
      formElement.reset();
      await refreshAll();
    }, "Funds added to the account.");
  }

  async function authorizeCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const merchant = String(form.get("merchant") ?? "");
    const amountCents = toCents(String(form.get("amount") ?? ""));
    await submit(async () => {
      await api(`/api/accounts/${accountId}/card-authorizations`, {
        method: "POST",
        body: JSON.stringify({ merchant, amountCents, externalAuthId: `auth-${crypto.randomUUID()}` }),
      });
      formElement.reset();
      await refreshAll();
    }, "Card authorization placed.");
  }

  async function settleHold(hold: CardHold) {
    let amountCents: number;
    try {
      amountCents = toCents(settlementAmounts[hold.id] ?? (hold.amountCents / 100).toFixed(2));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid settlement amount.");
      return;
    }
    await submit(async () => {
      const settlementEvent = {
        holdId: hold.id,
        amountCents,
        provider: "demo-processor",
        externalEventId: `settlement-${crypto.randomUUID()}`,
      };
      const result = await api<{ duplicate: boolean }>(`/api/accounts/${accountId}/card-settlements`, {
        method: "POST",
        body: JSON.stringify(settlementEvent),
      });
      if (!result.duplicate) setLastSettlementEvent(settlementEvent);
      await refreshAll();
    }, "Card purchase settled.");
  }

  async function replayLastSettlement() {
    if (!lastSettlementEvent) return;
    await submit(async () => {
      const result = await api<{ duplicate: boolean }>(`/api/accounts/${accountId}/card-settlements`, {
        method: "POST",
        body: JSON.stringify(lastSettlementEvent),
      });
      if (!result.duplicate) throw new Error("The API did not recognize this event as a duplicate.");
      await refreshAll();
    }, "Duplicate event recognized. No second debit was posted.");
  }

  async function reverseHold(hold: CardHold) {
    await submit(async () => {
      await api(`/api/accounts/${accountId}/card-reversals`, {
        method: "POST",
        body: JSON.stringify({ holdId: hold.id, provider: "demo-processor", externalEventId: `reversal-${crypto.randomUUID()}` }),
      });
      await refreshAll();
    }, "Card purchase reversed.");
  }

  async function createPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const recipient = String(form.get("recipient") ?? "");
    const amountCents = toCents(String(form.get("amount") ?? ""));
    await submit(async () => {
      await api(`/api/accounts/${accountId}/payments`, {
        method: "POST",
        headers: { "Idempotency-Key": `payment-${crypto.randomUUID()}` },
        body: JSON.stringify({ recipient, amountCents }),
      });
      formElement.reset();
      await refreshAll();
    }, "Payment created and funds reserved.");
  }

  async function updatePayment(payment: Payment, status: "completed" | "returned") {
    await submit(async () => {
      await api(`/api/accounts/${accountId}/payments/${payment.id}/events`, {
        method: "POST",
        body: JSON.stringify({ status, provider: "demo-processor", externalEventId: `payment-${status}-${crypto.randomUUID()}` }),
      });
      await refreshAll();
    }, `Payment marked ${status}.`);
  }

  async function importExternalRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    let amountCents: number;
    try {
      amountCents = toCents(String(form.get("amount") ?? ""), true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid amount.");
      return;
    }
    const provider = String(form.get("provider") ?? "");
    const description = String(form.get("description") ?? "");
    await submit(async () => {
      await api("/api/operations/external-records", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          provider,
          externalRecordId: `external-${crypto.randomUUID()}`,
          amountCents,
          occurredAt: new Date().toISOString(),
          description,
          currency: account?.currency ?? "USD",
        }),
      });
      formElement.reset();
      await refreshAll();
    }, "External record imported.");
  }

  async function matchRecord(row: ReconciliationRow) {
    const ledgerEntry = row.candidateLedgerEntry;
    if (!ledgerEntry) return;
    await submit(async () => {
      await api("/api/operations/reconciliation/matches", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          externalRecordId: row.externalRecord.id,
          ledgerEntryId: ledgerEntry.id,
          reason: row.status === "mismatch_suggested" ? "Operator confirmed a possible amount mismatch." : "Operator confirmed the suggested match.",
        }),
      });
      await refreshAll();
    }, "Record linked. The reconciliation report has been refreshed.");
  }

  async function createCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    let amountCents: number;
    try {
      amountCents = toCents(String(form.get("amount") ?? ""), true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter a valid correction amount.");
      return;
    }
    const reason = String(form.get("reason") ?? "");
    const externalRecordId = String(form.get("externalRecordId") ?? "");
    await submit(async () => {
      await api("/api/operations/corrections", {
        method: "POST",
        headers: { "Idempotency-Key": `correction-${crypto.randomUUID()}` },
        body: JSON.stringify({ accountId, amountCents, reason, ...(externalRecordId ? { externalRecordId } : {}) }),
      });
      formElement.reset();
      await refreshAll();
    }, "Correction added as a new ledger entry.");
  }

  const currency = account?.currency ?? "USD";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home">Morrow</a>
        <nav className="view-switch" aria-label="Choose workspace">
          <button className={view === "owner" ? "selected" : ""} onClick={() => setView("owner")}>Business owner</button>
          <button className={view === "operations" ? "selected" : ""} onClick={() => setView("operations")}>Operations</button>
        </nav>
        <div className="account-select">
          <label htmlFor="account-select">Account</label>
          {accounts.length > 0 ? (
            <select id="account-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          ) : <span>No account yet</span>}
        </div>
      </header>

      <div className="page-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">BUSINESS BANKING DEMO</p>
            <h1>{view === "owner" ? "Account overview" : "Operations review"}</h1>
            <p className="subheading">{view === "owner" ? "Balances and activity for your business account." : "Compare account activity with external payment records."}</p>
          </div>
          {account && <div className="account-name">{account.name}<small>{account.currency} account</small></div>}
        </div>

        {error && <div className="message error" role="alert">{error}</div>}
        {notice && <div className="message success" role="status">{notice}</div>}

        {!account && accounts.length === 0 ? (
          <section className="panel setup-panel">
            <h2>Open a business account</h2>
            <p>Create the demo account to start adding funds and recording activity.</p>
            <form className="inline-form" onSubmit={createAccount}>
              <label>Business name<input name="name" placeholder="Fieldwork Studio" required minLength={2} maxLength={120} /></label>
              <button className="button primary" disabled={busy}>Create account</button>
            </form>
          </section>
        ) : view === "owner" ? (
          <>
            <section className="balance-grid">
              <article className="balance-card main-balance">
                <span>Available to spend</span>
                <strong>{balance ? dollars(balance.availableBalanceCents, currency) : "Loading…"}</strong>
                <small>Posted funds minus open holds and pending payments</small>
              </article>
              <article className="balance-card">
                <span>Recorded balance</span>
                <strong>{balance ? dollars(balance.recordedBalanceCents, currency) : "Loading…"}</strong>
                <small>Includes funds that may not be available yet</small>
              </article>
              <article className="balance-card">
                <span>Pending funds</span>
                <strong>{balance ? dollars(balance.pendingIncomingCents, currency) : "Loading…"}</strong>
                <small>Not yet available to spend</small>
              </article>
            </section>

            <section className="form-grid">
              <form className="panel form-panel" onSubmit={addFunds}>
                <h2>Add funds</h2>
                <p>Record an incoming transfer to the business account.</p>
                <label>Amount in dollars<input name="amount" type="number" min="0.01" step="0.01" placeholder="500.00" required /></label>
                <label>Description<input name="description" placeholder="Incoming bank transfer" maxLength={240} /></label>
                <button className="button primary" disabled={busy}>Record funds</button>
              </form>

              <form className="panel form-panel" onSubmit={authorizeCard}>
                <h2>Card purchase</h2>
                <p>Create an authorization hold on the business card.</p>
                <label>Merchant<input name="merchant" placeholder="Northstar Coffee Roasters" required maxLength={160} /></label>
                <label>Authorization amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="80.00" required /></label>
                <button className="button primary" disabled={busy}>Place hold</button>
              </form>

              <form className="panel form-panel" onSubmit={createPayment}>
                <h2>Send a payment</h2>
                <p>Pending payments reserve funds until their status changes.</p>
                <label>Recipient<input name="recipient" placeholder="Acme Supplies" required maxLength={160} /></label>
                <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="25.00" required /></label>
                <button className="button primary" disabled={busy}>Create payment</button>
              </form>
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Card authorizations</h2><p>Holds reduce available funds. Settlement replaces the hold with the final charge.</p></div><div className="section-actions">{lastSettlementEvent && <button className="button secondary" disabled={busy} onClick={() => void replayLastSettlement()}>Replay same settlement event</button>}<span className="quiet">Holds: {balance ? dollars(balance.cardHoldsCents, currency) : "—"}</span></div></div>
              {holds.length === 0 ? <p className="empty-state">No card activity yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Merchant</th><th>Authorized</th><th>Settled</th><th>Status</th><th>Actions</th></tr></thead><tbody>
                  {holds.map((hold) => <tr key={hold.id}>
                    <td>{hold.merchant}<small>{dateTime(hold.createdAt)}</small></td>
                    <td>{dollars(hold.amountCents, currency)}</td>
                    <td>{hold.settledAmountCents === null ? "—" : dollars(hold.settledAmountCents, currency)}</td>
                    <td><span className={`status status-${hold.reversed ? "returned" : hold.status}`}>{hold.reversed ? "Reversed" : hold.status}</span></td>
                    <td className="actions-cell">
                      {hold.status === "open" && <><input className="small-money" aria-label="Final settlement amount" type="number" min="0.01" step="0.01" value={settlementAmounts[hold.id] ?? (hold.amountCents / 100).toFixed(2)} onChange={(event) => setSettlementAmounts((current) => ({ ...current, [hold.id]: event.target.value }))} /><button className="button secondary" disabled={busy} onClick={() => void settleHold(hold)}>Settle</button></>}
                      {hold.status === "settled" && !hold.reversed && <button className="button secondary" disabled={busy} onClick={() => void reverseHold(hold)}>Reverse settled charge</button>}
                    </td>
                  </tr>)}
                </tbody></table></div>
              )}
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Outbound payments</h2><p>Mark simulated payment events as completed or returned.</p></div><span className="quiet">Reserved: {balance ? dollars(balance.pendingPaymentsCents, currency) : "—"}</span></div>
              {payments.length === 0 ? <p className="empty-state">No outbound payments yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Recipient</th><th>Amount</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody>
                  {payments.map((payment) => <tr key={payment.id}>
                    <td>{payment.recipient}</td><td>{dollars(payment.amountCents, currency)}</td><td><span className={`status status-${payment.status}`}>{payment.status}</span></td><td>{dateTime(payment.createdAt)}</td>
                    <td className="actions-cell">{payment.status === "pending" && <><button className="button secondary" disabled={busy} onClick={() => void updatePayment(payment, "completed")}>Mark completed</button><button className="button plain" disabled={busy} onClick={() => void updatePayment(payment, "returned")}>Return</button></>}{payment.status === "completed" && <button className="button secondary" disabled={busy} onClick={() => void updatePayment(payment, "returned")}>Mark returned</button>}</td>
                  </tr>)}
                </tbody></table></div>
              )}
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Transaction history</h2><p>Posted ledger entries. Original charges remain visible after reversal.</p></div></div>
              {entries.length === 0 ? <p className="empty-state">No posted transactions yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Description</th><th>Type</th><th>Date</th><th className="amount-column">Amount</th></tr></thead><tbody>
                  {entries.map((entry) => <tr key={entry.id}><td>{entry.description}</td><td>{entry.type.replaceAll("_", " ")}</td><td>{dateTime(entry.createdAt)}</td><td className={`amount-column ${entry.amountCents > 0 ? "credit" : ""}`}>{dollars(entry.amountCents, currency)}</td></tr>)}
                </tbody></table></div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="summary-grid">
              <Summary label="External records" value={reconciliation?.summary.externalRecords ?? "—"} />
              <Summary label="Matched" value={reconciliation?.summary.matched ?? "—"} />
              <Summary label="Mismatched" value={reconciliation?.summary.mismatched ?? "—"} />
              <Summary label="Missing from account" value={reconciliation?.summary.externalOnly ?? "—"} />
              <Summary label="Missing externally" value={reconciliation?.summary.internalOnly ?? "—"} />
            </section>

            <section className="form-grid operations-forms">
              <form className="panel form-panel" onSubmit={importExternalRecord}>
                <h2>Import external record</h2>
                <p>Use a negative amount for money leaving the account.</p>
                <label>Provider<input name="provider" defaultValue="demo-processor" required maxLength={80} /></label>
                <label>Description<input name="description" placeholder="Northstar Coffee Roasters" required maxLength={240} /></label>
                <label>Amount in dollars<input name="amount" type="number" step="0.01" placeholder="-65.00" required /></label>
                <button className="button primary" disabled={busy}>Import record</button>
              </form>
              <form className="panel form-panel" onSubmit={createCorrection}>
                <h2>Record a correction</h2>
                <p>Corrections create new ledger entries and retain the explanation.</p>
                <label>Related external record<select name="externalRecordId" defaultValue=""><option value="">No linked record</option>{reconciliation?.externalRecords.map((row) => <option value={row.externalRecord.id} key={row.externalRecord.id}>{row.externalRecord.description} ({row.externalRecord.externalRecordId})</option>)}</select></label>
                <label>Correction amount<input name="amount" type="number" step="0.01" placeholder="5.00" required /></label>
                <label>Reason<input name="reason" placeholder="Explain the difference" required minLength={3} maxLength={500} /></label>
                <button className="button primary" disabled={busy}>Add correction</button>
              </form>
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>External records</h2><p>Suggested matches are based on amount and date. Confirming a match is recorded in the operations log.</p></div><button className="button secondary" disabled={busy} onClick={() => void refreshReconciliation().catch((cause) => setError(cause instanceof Error ? cause.message : "Refresh failed."))}>Refresh</button></div>
              {!reconciliation || reconciliation.externalRecords.length === 0 ? <p className="empty-state">No external records imported yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>External record</th><th>Amount</th><th>Reconciliation</th><th>Ledger candidate / difference</th><th>Action</th></tr></thead><tbody>
                  {reconciliation.externalRecords.map((row) => {
                    const ledger = row.ledgerEntry ?? row.candidateLedgerEntry;
                    return <tr key={row.externalRecord.id}>
                      <td>{row.externalRecord.description}<small>{row.externalRecord.provider} · {row.externalRecord.externalRecordId}</small></td>
                      <td>{dollars(row.externalRecord.amountCents, row.externalRecord.currency)}</td>
                      <td><span className={`status status-${row.status}`}>{row.status.replaceAll("_", " ")}</span></td>
                      <td>{ledger ? <>{ledger.description}<small>{dollars(ledger.amountCents, currency)}{row.differenceCents ? ` · difference ${dollars(row.differenceCents, currency)}` : ""}</small></> : "No ledger match found"}{row.actions?.map((action) => <small key={action.id}>{action.action.replaceAll("_", " ")}: {action.reason}</small>)}</td>
                      <td>{row.candidateLedgerEntry && <button className="button secondary" disabled={busy} onClick={() => void matchRecord(row)}>Confirm match</button>}</td>
                    </tr>;
                  })}
                </tbody></table></div>
              )}
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Ledger entries without an external match</h2><p>These records may be missing from the external statement.</p></div></div>
              {reconciliation?.internalOnly.length ? <div className="table-wrap"><table><thead><tr><th>Description</th><th>Amount</th><th>Date</th></tr></thead><tbody>{reconciliation.internalOnly.map((entry) => <tr key={entry.id}><td>{entry.description}</td><td>{dollars(entry.amountCents, currency)}</td><td>{dateTime(entry.createdAt)}</td></tr>)}</tbody></table></div> : <p className="empty-state">No unmatched ledger entries.</p>}
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div className="summary-card"><span>{label}</span><strong>{value}</strong></div>;
}
