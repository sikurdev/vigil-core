import { readinessResponse } from "@/lib/readiness";

/**
 * The original probe, kept as a documented alias for `/api/ready`.
 *
 * Every Docker healthcheck, `vigilctl` install and external monitor
 * pointed at an installation since 1.0 calls this path, and they call it
 * to decide whether the application is usable — not whether the process
 * is running. Redefining it as liveness would silently turn all of them
 * into checks that pass while the database is empty, which is the
 * failure this change exists to remove. Deleting it would break them
 * outright. So it keeps its URL, its body and its status codes, and
 * answers the stricter question its callers already believed it was
 * answering.
 *
 * New deployments should call `/api/ready` and `/api/live` by name.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return readinessResponse();
}
