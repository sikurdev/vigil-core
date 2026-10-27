# Contributing

## Before you build something big

**Open an issue first** for anything beyond a bug fix. Some things are
out of scope for Core (see "Scope" below).

Bug fixes, documentation fixes, and test additions need no preamble:
send the pull request.

## Development setup

```bash
npm install
cp .env.example .env          # DATABASE_URL + BETTER_AUTH_SECRET
npm run db:migrate
npm run dev                   # app
npm run worker:dev            # background checks
```

Tests need a separate database: point `TEST_DATABASE_URL` at one; the
suite migrates it itself:

```bash
TEST_DATABASE_URL=postgresql://postgres@localhost:5432/vigil_core_test npm test
```

Before you open a pull request:

```bash
npm run lint && npm run typecheck && npm test && npm run format:check
```

CI runs the same four plus a Playwright end-to-end pass and a Docker
build. See [docs/HANDBOOK.md](docs/HANDBOOK.md) for the full command
table and debugging notes.

## Conventions worth knowing

These are not style preferences; breaking them breaks things:

- **Services take `(db, actor, input)`.** `actor` is
  `{ organizationId, userId }`; every query is scoped by
  `organizationId`. That signature is what keeps tenants isolated.
- **The check loop owns monitor state.** `runMonitorCheck` is the only
  thing that advances a monitor's status or auto-resolves its incident.
- **Resolved incidents are terminal.** No transitions out of `resolved`.
- **Webhook signatures cover the exact body sent**: if you change how a
  body is built, the signature must be computed over the final bytes.
- **Migrations are append-only.** Change the schema in
  `src/db/schema/`, run `npm run db:generate`, commit the generated SQL.
  Never edit a migration that has shipped.
- **Timeline events marked `internal` (and `system` events) never reach
  the public status page.** If you add a new event type, decide which
  side of that line it sits on, and add a test.

## Tests

New behavior needs a test. The suite is split:

- `tests/unit/`: pure functions, no database.
- `tests/integration/`: real Postgres, one throwaway organization per
  test (`createTestOrg`), so tests run in parallel safely.
- `e2e/`: Playwright, the golden path through the running app.

## Scope

Core is an uptime monitor for one team: forty check types, incidents,
status pages, email and webhook alerts. Multi-tenancy, automatic
recovery, on-call rotation and SMS paging are commercial and will not
be merged here. See the README.

**More notification providers** are the gap called out under Limitations
in the README.

## Licensing your contribution

This project is Apache-2.0. Under section 5 of that license, anything
you deliberately submit for inclusion is contributed under the same
terms unless you say otherwise, so **there is no CLA to sign and no
copyright to assign.**

Apache-2.0 lets the maintainer include your contribution in the
commercial edition, which is sold. You keep your copyright, your name
stays on the commit, and you can use your own work anywhere. If you do
not want that, say so in the issue. A bug report with a clear
reproduction is useful on its own.

## Code of conduct

Be decent. Assume good faith, keep criticism about the code, and don't
make people regret showing up. Behavior that makes this an unpleasant
place gets you removed from it.
