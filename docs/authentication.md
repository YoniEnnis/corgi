# Demo authentication

The app has two roles:

- **Business owner** can list and create accounts, add funds, create card activity, and manage outbound payments.
- **Operations reviewer** can list accounts, import external records, review reconciliation, link records, and add corrections.

The API checks the signed session cookie and role on every account or operations route. The cookie is HTTP-only, SameSite Strict, and expires after eight hours. The health check and sign-in/session endpoints are public.

## Local development

When `NODE_ENV=development` and no demo credentials are configured, the app provides these local-only accounts:

| Role | Email | Password |
|---|---|---|
| Owner | `owner@example.test` | `Owner-demo-123!` |
| Operations | `ops@example.test` | `Ops-demo-123!` |

You can replace these using `.env.local`:

```dotenv
SESSION_SECRET=replace-with-a-random-secret
DEMO_OWNER_EMAIL=owner@example.test
DEMO_OWNER_PASSWORD=replace-with-a-unique-password
DEMO_OPERATIONS_EMAIL=ops@example.test
DEMO_OPERATIONS_PASSWORD=replace-with-a-different-unique-password
```

Restart the development server after changing environment values. Keep `.env.local` private; it is ignored by Git.

## Vercel

The local fallback credentials are disabled outside development. Before deploying, add all five variables above to the Vercel project for the environments you use. Use unique passwords and a randomly generated `SESSION_SECRET` of at least 32 bytes. If these settings are missing, sign-in is disabled and protected APIs reject requests.

This is lightweight interview-demo authentication: users and passwords are configured in environment variables, and sessions are stateless. It does not include password reset, account lockout, or server-side session revocation.
