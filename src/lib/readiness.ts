import { Pool, type PoolClient, type QueryConfig } from "pg";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import journal from "../../drizzle/meta/_journal.json";

/**
 * What this build means by "ready", as opposed to "alive".
 *
 * `select 1` is not readiness. It answers whether a Postgres server
 * accepted a connection, and every failure this endpoint exists to catch
 * survives it: an empty database, a database whose migration job is
 * still running, a database left half-migrated by a job that died, a
 * database belonging to some other application entirely. All four accept
 * `select 1` instantly, so a load balancer that trusted it sent traffic
 * to a process whose very first query would fail on a missing table.
 *
 * Readiness here is the comparison `vigilctl doctor` already makes from
 * the outside (see `scripts/vigilctl/stack.sh`, `migrations_on_disk` and
 * `migrations_applied`): every migration this build ships must be
 * recorded as applied in drizzle's ledger. Moving it inside the process
 * is what lets an orchestrator ask the question, since an orchestrator
 * has no shell on the host and no psql.
 *
 * The endpoint never applies anything. A probe that migrates is a probe
 * that can be made to migrate by anyone who can reach it, and a rolling
 * deploy where several replicas race to migrate is worse than one that
 * refuses traffic until a single migration job has finished.
 */

/**
 * The migrations packaged in THIS build, by the journal timestamp
 * drizzle stores in the ledger.
 *
 * Imported rather than read from disk. The web image is a standalone
 * Next bundle — `Dockerfile` copies `.next/standalone`, `.next/static`
 * and `public`, and no `drizzle/` — so a runtime `readFile` would fail
 * in the one deployment this endpoint is for. A static import also makes
 * the claim literal: the expected set is inside the artefact being asked
 * whether it is ready, and cannot drift from it.
 *
 * The timestamp, never the hash. `strip-ee` DELETES the commercial
 * blocks from fifteen of these migration files, twelve of which are
 * wholly commercial and reach Core as zero-byte files — so in Core those
 * twelve all record the sha256 of the empty string and the hash cannot
 * even say which migration a row is. Drizzle itself never reads the
 * column: it decides what to apply from `created_at` alone
 * (`pg-core/dialect.js`), which is the field both editions agree on and
 * the only one worth comparing.
 */
const EXPECTED_MIGRATIONS: readonly number[] = journal.entries.map(
  (entry) => entry.when,
);

/**
 * Why the answer was no. Never sent to the caller — a public probe that
 * distinguishes "no schema" from "schema five migrations behind" tells
 * an unauthenticated stranger which release you are mid-way through.
 * It goes to the log, where the operator is.
 */
export type NotReadyReason =
  /** Postgres refused the connection, or dropped it. */
  | "unreachable"
  /** Postgres accepted the connection and did not answer in time. */
  | "timeout"
  /** Reachable, but drizzle's ledger does not exist: nothing has ever
   * been migrated here. */
  | "unmigrated"
  /** The ledger exists and is missing at least one of this build's
   * migrations. */
  | "incomplete";

export type Readiness =
  { ready: true } | { ready: false; reason: NotReadyReason };

/**
 * How long the probe may take before it answers "no" on its own.
 *
 * Three seconds, and the number comes from the healthcheck that consumes
 * it: `docker-compose.yml` allows the probe `timeout: 5s`, and that five
 * seconds has to cover starting node and issuing the request as well as
 * the queries below. Three leaves the margin.
 *
 * This is the EXTERNAL contract, and on its own it was not enough. A
 * deadline that only settles the HTTP response leaves the database work
 * running: a Postgres that has been firewalled off, paused, or moved
 * behind a load balancer that accepts and forwards nowhere completes the
 * TCP handshake and then says nothing, and a pool with no
 * `connectionTimeoutMillis` never gives that client up. Measured on the
 * application's own pool options, five probes left five sockets open
 * with nothing to reap them; at `max` the pool is spent and the
 * application it was borrowed from stops being able to query at all.
 * The probe would then be the outage.
 *
 * So the bound below is the promise, and `READINESS_POOL_OPTIONS` is how
 * it is kept.
 */
export const READINESS_TIMEOUT_MS = 3_000;

/**
 * The pool the probe owns, and every bound in it.
 *
 * Separate from `src/db`'s on purpose, and the separation is the point
 * rather than a convenience:
 *
 *  - **It cannot spend the application's connections.** The failure this
 *    exists for is a database that accepts and stalls, and a probe that
 *    borrowed the application's pool for that would take ten connections
 *    out of it and hand back an unhealthy container whose real problem
 *    was the probe.
 *  - **The application's queries are untouched.** `statement_timeout`
 *    and `query_timeout` here are a probe's numbers - a second is
 *    forever for `select to_regclass(...)` and much too short for a
 *    retention sweep. Setting them on the shared pool would silently
 *    cap every query in the product.
 *  - **It cannot be starved by load.** Readiness answers "is the
 *    database reachable and migrated", not "is the application busy". A
 *    saturated pool is a capacity signal; taking a replica out of
 *    rotation for it is how one busy node becomes an outage.
 *
 * Exported because `tests/integration/health-readiness.test.ts` builds
 * its pool from these exact options. A test that chose its own would be
 * proving that some options release the connection, not that the shipped
 * ones do.
 *
 * `connectionTimeoutMillis` is the load-bearing one. pg-pool destroys the
 * socket when it fires (`client.connection.stream.destroy()`), the
 * connect callback then filters the client out of `_clients`, and a
 * request still queued behind `max` is dropped from `_pendingQueue` by
 * the same option - so both the active and the waiting counts come back
 * to where they started instead of climbing.
 */
export const READINESS_POOL_OPTIONS = {
  /** Two: one probe in flight, one arriving as it finishes. Anything
   * past that queues, and the queue is bounded by the same timeout. */
  max: 2,
  /** Covers DNS, the TCP handshake, the startup packet and auth. Under
   * the budget above with room for the queries. */
  connectionTimeoutMillis: 1_500,
  /** Server-side, sent in the startup packet, so a statement that
   * overruns is cancelled by Postgres rather than merely abandoned by
   * us. Only this pool's connections carry it. */
  statement_timeout: 1_000,
  /** Client-side backstop for a connection that is established and then
   * silent, where the server-side timeout can never fire because
   * nothing is reading. Overridden per query from the budget. */
  query_timeout: 1_000,
  /** A probe every thirty seconds does not need a warm connection kept
   * for minutes, and an idle socket to a database that has since gone
   * away is a failure deferred. */
  idleTimeoutMillis: 10_000,
  /** The probe must never be the reason a process cannot exit. */
  allowExitOnIdle: true,
} as const;

/**
 * The pool this process probes with, made once.
 *
 * Keyed on the URL rather than simply cached, so a test that repoints
 * `DATABASE_URL` and re-imports gets a pool for the database it asked
 * for, and the one it replaced is ended rather than left holding
 * sockets.
 */
const globalForReadiness = globalThis as unknown as {
  vigilReadinessPool?: { url: string; pool: Pool };
};

export function readinessPool(): Pool {
  const held = globalForReadiness.vigilReadinessPool;
  if (held && held.url === env.DATABASE_URL) return held.pool;
  void held?.pool.end().catch(() => {});

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ...READINESS_POOL_OPTIONS,
  });
  // A pool with no error listener takes the process down when an idle
  // client's socket dies, which is precisely the case being probed.
  pool.on("error", (error) => {
    logger.debug({ err: error }, "readiness pool client errored while idle");
  });
  globalForReadiness.vigilReadinessPool = { url: env.DATABASE_URL, pool };
  return pool;
}

/**
 * Reads the migration ledger and compares it with this build's journal.
 *
 * Takes its pool so a test can point it at an unreachable server, an
 * empty database, a half-migrated one and one that accepts the
 * connection and never answers — the four states that matter and the
 * four the previous implementation reported as healthy.
 *
 * Never rejects, in any of them, and never leaves work behind. Every
 * step is bounded by something that RELEASES: the connection by
 * `connectionTimeoutMillis`, which destroys the socket and drops the
 * client from the pool; each statement by a `query_timeout` computed
 * from what is left of the budget, and by `statement_timeout` on the
 * server. The `Promise.race` below is the backstop that keeps the HTTP
 * contract if some path escapes all three — it is no longer the only
 * thing standing between a stalled database and a probe that never
 * answers.
 *
 * A database that is AHEAD of this build stays ready. That is a replica
 * still serving during a rolling deploy where the migration job has
 * already run, and refusing it would take the old replicas out of
 * rotation at exactly the moment they are the only ones left. `vigilctl
 * doctor` treats the same state as a warning rather than a failure.
 *
 * The test is set membership, not `max(created_at)`, and the two differ
 * on exactly one state: a ledger with a GAP below its maximum. Drizzle
 * only ever appends past the maximum, so no interrupted run can produce
 * one — it takes a hand-edited ledger or a dump restored from an
 * incoherent tree. In that state the schema really is missing DDL, and
 * `drizzle-kit migrate` will NOT repair it: it skips everything at or
 * below the maximum. Reporting ready would be the lie; reporting not
 * ready is a red probe an operator has to look at, which is the point.
 */
export async function checkReadiness(pool: Pool): Promise<Readiness> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readLedger(pool, deadline),
      new Promise<Readiness>((resolve) => {
        timer = setTimeout(
          () => resolve({ ready: false, reason: "timeout" }),
          READINESS_TIMEOUT_MS,
        );
        // A probe must never be the reason a process cannot exit.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A statement with a client-side deadline on it.
 *
 * `query_timeout` per statement is a documented pg feature - `lib/
 * client.js` reads `config.query_timeout` before falling back to the
 * connection parameter - and `@types/pg` does not carry it on
 * `QueryConfig`. Declared here rather than cast at each call site, so
 * the omission is stated once and the values stay checked.
 */
type TimedQuery = QueryConfig & { query_timeout: number };

/**
 * What this statement may have, as a `query_timeout`.
 *
 * The smaller of what is left of the shared budget and the per-statement
 * ceiling, floored so a statement is always actually issued and
 * shortened by a margin so the answer beats the outer deadline rather
 * than tying with it. Both bounds are needed: the budget keeps the sum
 * of the steps under the contract, and the ceiling keeps any one of
 * them honest - these are two trivial reads, and a second is already
 * three orders of magnitude more than either has ever taken.
 */
function remaining(deadline: number): number {
  const left = deadline - Date.now() - 100;
  return Math.max(100, Math.min(READINESS_POOL_OPTIONS.query_timeout, left));
}

/**
 * The connection and the two statements, each bounded by the same
 * deadline so their sum is too.
 *
 * Never throws, so the losing side of the race cannot become an
 * unhandled rejection when the backstop wins.
 */
async function readLedger(pool: Pool, deadline: number): Promise<Readiness> {
  const startedAt = Date.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    // pg-pool reports a refused connection and an expired
    // `connectionTimeoutMillis` through the same rejection, and tells
    // them apart only in the message text. Time separates them without
    // parsing English: a refusal comes back in milliseconds.
    const spent = Date.now() - startedAt;
    const reason =
      spent >= READINESS_POOL_OPTIONS.connectionTimeoutMillis
        ? "timeout"
        : "unreachable";
    return { ready: false, reason };
  }

  // Any failure past this point releases the client with the error
  // rather than without it: `release(err)` destroys the connection
  // instead of returning it to the pool. A statement we stopped waiting
  // for may still be on the wire, and a connection whose protocol state
  // is unknown is not one to hand to the next probe.
  try {
    const presence: TimedQuery = {
      text: "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
      query_timeout: remaining(deadline),
    };
    const present = await client.query<{ present: boolean }>(presence);
    if (present.rows[0]?.present !== true) {
      client.release();
      return { ready: false, reason: "unmigrated" };
    }

    // `created_at` is `bigint`, which node-postgres hands back as a
    // string; cast so there is one type to convert rather than two.
    const rows: TimedQuery = {
      text: "select created_at::text as applied_at from drizzle.__drizzle_migrations",
      query_timeout: remaining(deadline),
    };
    const ledger = await client.query<{ applied_at: string | null }>(rows);
    client.release();

    const applied = new Set(
      ledger.rows
        .map((row) => (row.applied_at === null ? NaN : Number(row.applied_at)))
        .filter((value) => Number.isFinite(value)),
    );
    const missing = EXPECTED_MIGRATIONS.filter((when) => !applied.has(when));
    if (missing.length > 0) return { ready: false, reason: "incomplete" };
    return { ready: true };
  } catch (error) {
    client.release(error instanceof Error ? error : new Error("probe failed"));
    // The connection was there a statement ago. Either something took
    // the database away mid-probe, or it stopped answering — and a
    // statement that ran out of budget is the timeout case.
    const reason = Date.now() >= deadline - 200 ? "timeout" : "unreachable";
    return { ready: false, reason };
  }
}

/** No caching. A cached readiness answer is a stale one, and a stale
 * readiness answer is the failure this endpoint exists to prevent.
 * `/api/live` spells the same header out for itself rather than import
 * it from here — see the note in that file. */
const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The body both `/api/ready` and `/api/health` return.
 *
 * `{"status":"ok"}` and `{"status":"unavailable"}` are the strings the
 * old `/api/health` returned, and the edition gate, `vigilctl` and
 * `docs/AGENCY.md` all read them. The contract that changed is what
 * `ok` means, not what it looks like.
 */
export async function readinessResponse(
  /** Defaulted, never passed by the routes. The seam exists so an
   * integration test can point the endpoint at a database of its own
   * without mocking `pg` out from under the thing it is testing. */
  pool: Pool = readinessPool(),
): Promise<Response> {
  const state = await checkReadiness(pool);
  if (state.ready) {
    return Response.json({ status: "ok" }, { headers: NO_STORE });
  }
  logger.warn({ reason: state.reason }, "readiness probe answered unavailable");
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: NO_STORE },
  );
}
