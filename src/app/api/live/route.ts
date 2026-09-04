/**
 * Liveness: can this process still serve an HTTP request?
 *
 * Nothing else. It touches no database, runs no migration and reads no
 * configuration, so the only way it fails is the only thing it is for —
 * a process that is wedged, out of memory, or gone. That is the signal a
 * restart policy should act on, and it is exactly the signal that must
 * NOT decide whether traffic may be sent here: a process answers this
 * happily while its database is empty. `/api/ready` answers that.
 *
 * This file imports NOTHING, and that is the contract rather than an
 * accident of it being short. Importing `@/lib/readiness` for the one
 * header constant would pull in `@/db`, which builds a connection pool
 * on the one route whose promise is that it needs no database — and
 * `@/lib/env`, which throws at import when `DATABASE_URL` is unset.
 * `tests/unit/health-contract.test.ts` holds the line.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}
