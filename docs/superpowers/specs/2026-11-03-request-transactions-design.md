# A request's transaction ends the way the request did — design

Date: 2026-11-03 · Branch: `request-transactions`, cut from `api-tenant-scope` (2f4a737) · No migration

## 1. The problems

Every API request runs inside one transaction, opened by `tenantContext` (`withTenant` or
`withAllTenants` in `packages/db/src/client.ts`). Webhooks get one from `webhookContext`. Two
things end that transaction wrongly.

1. **Code that commits in the middle.**
   - `setSystemPrompt` (`packages/db/src/agent-config.ts:163-183`) and `replaceBusy`
     (`packages/db/src/calendars.ts:169-188`) run their own `begin`/`commit`/`rollback` through
     `getPool()`. Inside a context that is the request's own connection.
   - Their `begin` does nothing; their `commit` commits the request's transaction early and drops
     its `set local` tenant settings. Every later query runs with no transaction and no tenant, so
     row-level security returns nothing.
   - So `PUT /api/organizations/:slug/agent/prompt` saves the prompt and then answers 400 "could
     not be read back".
   - `replaceBusy` runs inside the calendar sweep's `withTenant` and gets away with it only because
     nothing reads afterwards. Its `rollback` on failure would also discard work the caller did
     earlier in the same transaction.
2. **A handler that throws still commits.**
   - Hono catches a handler's error, answers 500 itself, and sets `c.error`. It never rethrows into
     the middleware: `await next()` resolves normally (verified with Hono 4.12.31).
   - `withClient` therefore sees success and commits whatever the handler wrote before the throw.

## 2. What success looks like

- `PUT …/agent/prompt` saves the prompt, keeps the old one as a version, and answers with the new
  config.
- A prompt or calendar change is atomic, without ending the transaction it runs in.
- A request whose handler throws leaves nothing behind in the database. The client still gets
  Hono's 500.
- A request whose handler answers, with any status including a deliberate 5xx, commits as today.

## 3. Decisions taken

- **`withSavepoint(fn)`** in `client.ts`:
  - Inside an ambient context, it runs `fn` between a uniquely named
    `savepoint` and `release savepoint`, and rolls back to the savepoint on failure, then rethrows.
    The caller's transaction and settings survive either way.
  - With no ambient context it throws a clear error. Both callers always run inside one, and
    without one, `getPool()` would spread the statements over different connections.
  - `setSystemPrompt` and `replaceBusy` use it in place of their `begin`/`commit`.
- **Roll back when the handler threw.**
  - Both middlewares wrap `next()`: after it returns, if `c.error` is set, they throw a private
    `HandlerFailed`, so `withClient` rolls back.
  - The middleware then catches `HandlerFailed` and returns, so Hono's 500 response stands.
  - It works through the double mount: the inner `/api/*` mount swallows its own `HandlerFailed`,
    and the outer business mount sees the same `c.error` and fails its transaction too.
- **An explicit error response commits.**
  - A handler that answers 4xx or 5xx itself has decided what the request did.
  - Some record a failure on purpose, such as a failed send or an import's refused rows.
  - Rejected: rolling back on every 5xx. It would silently undo those deliberate records.

## 4. Testing

Database tests run against a throwaway Postgres. They seed as the owner, act as `nexus_app`, and
take the shared advisory lock `20261102`.

- **`setSystemPrompt`** under `withTenant(org)` returns the new config, writes a version row, and
  leaves `app.current_org` set afterwards. It fails today with "could not be read back".
- **`replaceBusy`** under `withTenant(org)` writes the busy rows and leaves `app.current_org` set
  afterwards.
- **`withSavepoint`:**
  - work that throws is undone and the error comes through;
  - the surrounding transaction keeps working;
  - with no context it throws.
- **Request probe app**, with `tenantContext` mounted as `index.ts` mounts it, and `webhookContext`.
  Each route inserts a contact:
  - a route that then throws leaves no contact, and the response is 500;
  - a route that returns an explicit 500 keeps its contact;
  - a route that returns 200 keeps it;
  - the same "throws, nothing kept" behaviour holds for a webhook route.
- **Both suites** pass.

## 5. Delivery

- Branch `request-transactions`, worktree `C:\CLAUDE CODE\nexus-request-tx`. Committed locally
  only. Deploys after the four branches below it; no migration.
- Rollback: revert the branch's commits.

## 6. Out of scope

- Redis and queue work a handler did before throwing; it is not transactional.
- Changing any handler's own error responses.
