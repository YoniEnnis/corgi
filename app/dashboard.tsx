"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";

type Account = { id: string; name: string; currency: string };
type AuthUser = { email: string; role: "owner" | "operations" };
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
  externalAuthId: string;
  createdAt: string;
};
type Payment = {
  id: string;
  recipient: string;
  amountCents: number;
  status: "pending" | "completed" | "returned" | "failed";
  plaidTransferId: string | null;
  plaidStatus: string | null;
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
type ProviderEvent = { id: string; provider: string; type: string; deliveryCount: number; firstReceivedAt: string; lastReceivedAt: string };
type PlaidConnectionState = {
  configured: boolean;
  connected: boolean;
  connection: { institutionName: string; accountName: string; accountMask: string | null; createdAt: string } | null;
  ledgerBalance: { name: string; available: string; pending: string } | null;
  ledgerError: string | null;
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
  const [session, setSession] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [holds, setHolds] = useState<CardHold[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [stripeConfigured, setStripeConfigured] = useState(false);
  const [plaidConnection, setPlaidConnection] = useState<PlaidConnectionState | null>(null);
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);
  const [providerEvents, setProviderEvents] = useState<ProviderEvent[]>([]);
  const [view, setView] = useState<"owner" | "operations">("owner");
  const [showCreateAccount, setShowCreateAccount] = useState(false);
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

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoginBusy(true);
    setLoginError("");
    try {
      const result = await api<{ user: AuthUser }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      setSession(result.user);
      setView(result.user.role);
    } catch (cause) {
      setLoginError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function signOut() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setSession(null);
      setAccounts([]);
      setAccountId("");
      setBalance(null);
      setEntries([]);
      setHolds([]);
      setPayments([]);
      setStripeConfigured(false);
      setPlaidConnection(null);
      setReconciliation(null);
      setProviderEvents([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out failed.");
    }
  }

  async function refreshAccountData(id = accountId) {
    if (!id) return;
    const [balanceData, activityData] = await Promise.all([
      api<{ balances: Balance }>(`/api/accounts/${id}/balance`),
      api<{ entries: LedgerEntry[]; cardHolds: CardHold[]; payments: Payment[]; stripeConfigured: boolean }>(`/api/accounts/${id}/activity`),
    ]);
    const plaidData = await api<PlaidConnectionState>(`/api/accounts/${id}/plaid-connection`);
    setBalance(balanceData.balances);
    setEntries(activityData.entries);
    setHolds(activityData.cardHolds);
    setPayments(activityData.payments);
    setStripeConfigured(activityData.stripeConfigured);
    setPlaidConnection(plaidData);
  }

  async function refreshReconciliation(id = accountId) {
    if (!id) return;
    const [data, eventData] = await Promise.all([
      api<Reconciliation>(`/api/operations/reconciliation?accountId=${id}`),
      api<{ events: ProviderEvent[] }>(`/api/operations/provider-events?accountId=${id}`),
    ]);
    setReconciliation(data);
    setProviderEvents(eventData.events);
  }

  useEffect(() => {
    let active = true;
    api<{ user: AuthUser | null }>("/api/auth/session")
      .then((data) => {
        if (!active) return;
        setSession(data.user);
        if (data.user) setView(data.user.role);
      })
      .catch((cause) => {
        if (active) setLoginError(cause instanceof Error ? cause.message : "Could not check sign-in status.");
      })
      .finally(() => { if (active) setAuthReady(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authReady && session) void loadAccounts();
  }, [authReady, session]);

  useEffect(() => {
    if (!accountId) {
      setBalance(null);
      setEntries([]);
      setHolds([]);
      setPayments([]);
      setStripeConfigured(false);
      setPlaidConnection(null);
      setReconciliation(null);
      setProviderEvents([]);
      return;
    }
    if (session?.role === "owner") {
      void refreshAccountData().catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load account."));
    } else {
      setBalance(null);
      setEntries([]);
      setHolds([]);
      setPayments([]);
      setProviderEvents([]);
      void refreshReconciliation().catch(() => setReconciliation(null));
    }
  }, [accountId, session]);

  async function refreshAll() {
    if (session?.role === "owner") await refreshAccountData();
    else await refreshReconciliation();
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
      setShowCreateAccount(false);
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
      if (stripeConfigured) {
        await api(`/api/accounts/${accountId}/stripe-card-authorizations`, {
          method: "POST",
          body: JSON.stringify({ merchant, amountCents, requestId: crypto.randomUUID() }),
        });
      } else {
        await api(`/api/accounts/${accountId}/card-authorizations`, {
          method: "POST",
          body: JSON.stringify({ merchant, amountCents, externalAuthId: `auth-${crypto.randomUUID()}` }),
        });
      }
      formElement.reset();
      await refreshAll();
    }, stripeConfigured ? "Stripe test authorization placed." : "Simulated card authorization placed.");
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
      const stripeBacked = hold.externalAuthId.startsWith("pi_");
      if (stripeBacked) {
        const capture = await api<{ amountCents: number }>(`/api/accounts/${accountId}/stripe-card-holds/${hold.id}`, {
          method: "POST",
          body: JSON.stringify({ action: "capture", amountCents }),
        });
        amountCents = capture.amountCents;
      }
      const settlementEvent = {
        holdId: hold.id,
        amountCents,
        provider: stripeBacked ? "stripe-payments" : "demo-processor",
        externalEventId: stripeBacked ? `capture-${hold.externalAuthId}` : `settlement-${crypto.randomUUID()}`,
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
      const stripeBacked = hold.externalAuthId.startsWith("pi_");
      if (stripeBacked) {
        await api(`/api/accounts/${accountId}/stripe-card-holds/${hold.id}`, {
          method: "POST",
          body: JSON.stringify({ action: "refund" }),
        });
      }
      await api(`/api/accounts/${accountId}/card-reversals`, {
        method: "POST",
        body: JSON.stringify({
          holdId: hold.id,
          provider: stripeBacked ? "stripe-payments" : "demo-processor",
          externalEventId: stripeBacked ? `refund-${hold.externalAuthId}` : `reversal-${crypto.randomUUID()}`,
        }),
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
    const successMessage = plaidConnection?.connected
      ? "Plaid Sandbox transfer created; funds reserved."
      : "Payment created and funds reserved.";
    await submit(async () => {
      const result = await api<{ plaidConnected?: boolean; providerError?: string }>(`/api/accounts/${accountId}/payments`, {
        method: "POST",
        headers: { "Idempotency-Key": `payment-${crypto.randomUUID()}` },
        body: JSON.stringify({ recipient, amountCents }),
      });
      formElement.reset();
      await refreshAll();
      if (result.providerError) throw new Error("Payment is reserved, but Plaid could not create the transfer: " + result.providerError);
    }, successMessage);
  }

  async function connectPlaidSandbox() {
    await submit(async () => {
      await api(`/api/accounts/${accountId}/plaid-connection`, { method: "POST" });
      const data = await api<PlaidConnectionState>(`/api/accounts/${accountId}/plaid-connection`);
      setPlaidConnection(data);
    }, "Plaid Sandbox bank account connected.");
  }

  async function retryPlaidTransfer(payment: Payment) {
    await submit(async () => {
      let requestError: Error | null = null;
      try {
        await api(`/api/accounts/${accountId}/payments/${payment.id}/plaid-transfer`, { method: "POST" });
      } catch (cause) {
        requestError = cause instanceof Error ? cause : new Error("Could not create the Plaid transfer.");
      }
      await refreshAll();
      if (requestError) throw requestError;
    }, "Plaid Sandbox transfer created.");
  }

  async function simulatePlaidEvent(payment: Payment, eventType: "posted" | "settled" | "returned") {
    await submit(async () => {
      await api(`/api/accounts/${accountId}/payments/${payment.id}/plaid-events`, {
        method: "POST",
        body: JSON.stringify({ eventType }),
      });
      await refreshAll();
    }, eventType === "posted" ? "Plaid transfer posted." : eventType === "settled" ? "Plaid transfer settled and the ledger was updated." : "Plaid transfer returned and the ledger was updated.");
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

  if (!authReady) {
    return <main className="sign-in-shell"><p>Checking sign-in…</p></main>;
  }

  if (!session) {
    return <SignInForm onSubmit={signIn} busy={loginBusy} error={loginError} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#home">Morrow</a>
        <div className="role-label">{session.role === "owner" ? "Business owner" : "Operations reviewer"}</div>
        <div className="account-select">
          <label htmlFor="account-select">Account</label>
          {accounts.length > 0 ? (
            <select id="account-select" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
            </select>
          ) : <span>No account yet</span>}
          {accounts.length > 0 && session.role === "owner" && <button className="button secondary" onClick={() => setShowCreateAccount((current) => !current)}>{showCreateAccount ? "Cancel" : "New account"}</button>}
        </div>
        <div className="user-actions"><span>{session.email}</span><button className="button plain" onClick={() => void signOut()}>Sign out</button></div>
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

        {!account && accounts.length === 0 && session.role === "owner" ? (
          <section className="panel setup-panel">
            <h2>Open a business account</h2>
            <p>Create the demo account to start adding funds and recording activity.</p>
            <form className="inline-form" onSubmit={createAccount}>
              <label>Business name<input name="name" placeholder="Fieldwork Studio" required minLength={2} maxLength={120} /></label>
              <button className="button primary" disabled={busy}>Create account</button>
            </form>
          </section>
        ) : !account && accounts.length === 0 ? (
          <section className="panel setup-panel"><h2>No business accounts</h2><p>There are no accounts available to review yet.</p></section>
        ) : (
          <>
            {showCreateAccount && <section className="panel create-account-panel">
              <h2>Create a business account</h2>
              <p>The new account will start with a zero balance and one demo card.</p>
              <form className="inline-form" onSubmit={createAccount}>
                <label>Business name<input name="name" placeholder="Another Business" required minLength={2} maxLength={120} /></label>
                <button className="button primary" disabled={busy}>Create account</button>
              </form>
            </section>}
            {view === "owner" ? (
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
                <p>{plaidConnection?.connected ? "Plaid Sandbox sends the payout to the connected test bank. Recipient is used as the payment memo." : "Pending payments reserve funds until their status changes."}</p>
                <label>Recipient<input name="recipient" placeholder="Acme Supplies" required maxLength={160} /></label>
                <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="25.00" required /></label>
                <button className="button primary" disabled={busy}>Create payment</button>
              </form>
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Stripe Payments test mode</h2><p>Card actions use Stripe manual capture, then capture on settlement and refund on reversal.</p></div></div>
              <p>{stripeConfigured ? "Stripe test mode is connected. Payments use Stripe's pm_card_visa test method; no real money is moved." : "Stripe is not configured, so card actions use the local simulation."}</p>
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Plaid Transfer Sandbox</h2><p>Connect a fake bank account for outbound ACH payment testing.</p></div></div>
              {plaidConnection?.connected && plaidConnection.connection ? (
                <p>Connected to {plaidConnection.connection.institutionName}: {plaidConnection.connection.accountName}{plaidConnection.connection.accountMask ? " ending in " + plaidConnection.connection.accountMask : ""}.</p>
              ) : (
                <>
                  <p>{plaidConnection?.configured ? "Plaid Sandbox is configured. Connecting creates a fictional First Platypus Bank account; no real money moves." : "Plaid Sandbox credentials are not available to the app yet."}</p>
                  <button className="button secondary" disabled={busy || !plaidConnection?.configured} onClick={() => void connectPlaidSandbox()}>Connect sandbox bank</button>
                </>
              )}
              {plaidConnection?.ledgerBalance && (
                <p>Plaid payout ledger ({plaidConnection.ledgerBalance.name}): {dollars(Math.round(Number(plaidConnection.ledgerBalance.available) * 100), currency)} available, {dollars(Math.round(Number(plaidConnection.ledgerBalance.pending) * 100), currency)} pending. This is separate from the business account balance above.</p>
              )}
              {plaidConnection?.ledgerError && <p>Plaid payout ledger balance could not be read: {plaidConnection.ledgerError}</p>}
            </section>

            <section className="panel">
              <div className="section-title"><div><h2>Card authorizations</h2><p>Holds reduce available funds. Settlement replaces the hold with the final charge.</p></div><div className="section-actions">{lastSettlementEvent && <button className="button secondary" disabled={busy} onClick={() => void replayLastSettlement()}>Replay same settlement event</button>}<span className="quiet">Holds: {balance ? dollars(balance.cardHoldsCents, currency) : "—"}</span></div></div>
              {holds.length === 0 ? <p className="empty-state">No card activity yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Merchant</th><th>Authorized</th><th>Settled</th><th>Status</th><th>Actions</th></tr></thead><tbody>
                  {holds.map((hold) => <tr key={hold.id}>
                    <td>{hold.merchant}<small>{hold.externalAuthId.startsWith("pi_") ? "Stripe Payments test" : "Simulated"} · {dateTime(hold.createdAt)}</small></td>
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
              <div className="section-title"><div><h2>Outbound payments</h2><p>{plaidConnection?.connected ? "Advance Plaid Sandbox transfers through their provider events." : "Mark simulated payment events as completed or returned."}</p></div><span className="quiet">Reserved: {balance ? dollars(balance.pendingPaymentsCents, currency) : "—"}</span></div>
              {payments.length === 0 ? <p className="empty-state">No outbound payments yet.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Recipient / memo</th><th>Amount</th><th>Status</th><th>Provider</th><th>Created</th><th>Actions</th></tr></thead><tbody>
                  {payments.map((payment) => <tr key={payment.id}>
                    <td>{payment.recipient}</td>
                    <td>{dollars(payment.amountCents, currency)}</td>
                    <td><span className={`status status-${payment.status}`}>{payment.status}</span></td>
                    <td>{payment.plaidTransferId || payment.plaidStatus
                      ? "Plaid Sandbox: " + (payment.plaidStatus ?? "pending")
                      : plaidConnection?.connected ? "Not submitted" : "Local simulation"}</td>
                    <td>{dateTime(payment.createdAt)}</td>
                    <td className="actions-cell">
                      {payment.plaidTransferId ? (
                        <>
                          {payment.plaidStatus === "pending" && <button className="button secondary" disabled={busy} onClick={() => void simulatePlaidEvent(payment, "posted")}>Simulate posted</button>}
                          {payment.plaidStatus === "posted" && <><button className="button secondary" disabled={busy} onClick={() => void simulatePlaidEvent(payment, "settled")}>Simulate settled</button><button className="button plain" disabled={busy} onClick={() => void simulatePlaidEvent(payment, "returned")}>Simulate return</button></>}
                          {payment.plaidStatus === "settled" && payment.status === "completed" && <button className="button secondary" disabled={busy} onClick={() => void simulatePlaidEvent(payment, "returned")}>Simulate return</button>}
                        </>
                      ) : plaidConnection?.connected && payment.status === "pending" ? (
                        <button className="button secondary" disabled={busy} onClick={() => void retryPlaidTransfer(payment)}>Create Plaid transfer</button>
                      ) : (
                        <>{payment.status === "pending" && <><button className="button secondary" disabled={busy} onClick={() => void updatePayment(payment, "completed")}>Mark completed</button><button className="button plain" disabled={busy} onClick={() => void updatePayment(payment, "returned")}>Return</button></>}{payment.status === "completed" && <button className="button secondary" disabled={busy} onClick={() => void updatePayment(payment, "returned")}>Mark returned</button>}</>
                      )}
                    </td>
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

            <section className="panel">
              <div className="section-title"><div><h2>Provider event deliveries</h2><p>Stripe webhook receipts and Plaid Transfer status events for this account.</p></div><button className="button secondary" disabled={busy} onClick={() => void refreshReconciliation().catch((cause) => setError(cause instanceof Error ? cause.message : "Refresh failed."))}>Refresh events</button></div>
              {providerEvents.length === 0 ? <p className="empty-state">No provider events received yet. Stripe webhook receipts appear when the local listener is running; Plaid events appear after a transfer status is simulated.</p> : (
                <div className="table-wrap"><table><thead><tr><th>Provider</th><th>Event</th><th>Type</th><th>First received</th><th>Deliveries</th></tr></thead><tbody>
                  {providerEvents.map((event) => <tr key={event.provider + event.id}><td>{event.provider}</td><td>{event.id}</td><td>{event.type}</td><td>{dateTime(event.firstReceivedAt)}</td><td>{event.deliveryCount}</td></tr>)}
                </tbody></table></div>
              )}
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
          </>
        )}
      </div>
    </main>
  );
}

function Summary({ label, value }: { label: string; value: number | string }) {
  return <div className="summary-card"><span>{label}</span><strong>{value}</strong></div>;
}

function SignInForm({ onSubmit, busy, error }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; busy: boolean; error: string }) {
  return (
    <main className="sign-in-shell">
      <form className="panel sign-in-panel" onSubmit={onSubmit}>
        <a className="brand" href="#home">Morrow</a>
        <h1>Sign in</h1>
        <p>Sign in with your business owner or operations account.</p>
        {error && <div className="message error" role="alert">{error}</div>}
        <label>Email<input type="email" name="email" autoComplete="username" required /></label>
        <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
        <button className="button primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {process.env.NODE_ENV === "development" && <div className="demo-logins"><strong>Local demo accounts</strong><span>Owner: owner@example.test / Owner-demo-123!</span><span>Operations: ops@example.test / Ops-demo-123!</span></div>}
      </form>
    </main>
  );
}
