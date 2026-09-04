import { readinessResponse } from "@/lib/readiness";

/**
 * Readiness: may this process be sent traffic?
 *
 * 200 only when Postgres is reachable AND every migration this build
 * ships is recorded as applied. 503 for an unreachable server, an empty
 * database, and a database left part-way through a migration run — the
 * three states a `select 1` reported as healthy. See `lib/readiness.ts`
 * for how completeness is decided and why the body says nothing about
 * which of the three it was.
 *
 * Unauthenticated, like the endpoint it replaces, and it stays that way:
 * an orchestrator has no credentials. Nothing in the response
 * distinguishes an installation, a version or a schema state.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return readinessResponse();
}
