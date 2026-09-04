import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  connect as tcpConnect,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  READINESS_POOL_OPTIONS,
  READINESS_TIMEOUT_MS,
  checkReadiness,
  readinessResponse,
} from "@/lib/readiness";

/**
 * The four database states a `select 1` called healthy, and what the
 * probe leaves behind in each.
 *
 * `/api/health` used to answer 200 whenever Postgres accepted a
 * connection. Every Docker healthcheck, every `vigilctl` install and
 * every external monitor read that as "the application is usable", and
 * on an empty or half-migrated database it was not: the first query the
 * first request made would fail on a missing table, while the probe
 * stayed green and the load balancer kept sending traffic.
 *
 * So each state is built for real rather than simulated. An empty
 * database is a `CREATE DATABASE` and nothing else. A partial one is the
 * migration run that stopped one short — a truncated journal fed to
 * drizzle's own migrator, so the ledger it leaves behind is the ledger a
 * killed migrate job leaves behind, not a row somebody deleted. The
 * unreachable one is a pool pointed at a port with nothing on it, and
 * the fourth is a socket that accepts and then says nothing.
 *
 * Databases created here are dropped here. Nothing touches the suite's
 * own database except to read it.
 */

const MIGRATIONS = path.join(process.cwd(), "drizzle");

interface Journal {
  version: string;
  dialect: string;
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
}

/**
 * A pool built the way the product builds its readiness pool.
 *
 * `READINESS_POOL_OPTIONS` rather than options of this test's choosing,
 * because the thing under test is whether the SHIPPED bounds release the
 * connection. A test that added its own `connectionTimeoutMillis` would
 * pass against a product that had none.
 */
function probePool(url: string): Pool {
  const pool = new Pool({ connectionString: url, ...READINESS_POOL_OPTIONS });
  // A pool with no error listener takes the process down when an idle
  // client's socket dies, which is precisely what is being provoked.
  pool.on("error", () => {});
  return pool;
}

const suffix = randomUUID().slice(0, 8);
const EMPTY_DB = `vigil_ready_empty_${suffix}`;
const PARTIAL_DB = `vigil_ready_partial_${suffix}`;

let admin: Client;
let empty: Pool;
let partial: Pool;
let unreachable: Pool;
let partialFolder: string;
/** The migration the partially-migrated database never received. */
let withheld: string;

function scratchUrl(base: URL, name: string): string {
  const next = new URL(base.toString());
  next.pathname = `/${name}`;
  return next.toString();
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${EMPTY_DB}"`);
  await admin.query(`CREATE DATABASE "${PARTIAL_DB}"`);

  empty = probePool(scratchUrl(url, EMPTY_DB));
  partial = probePool(scratchUrl(url, PARTIAL_DB));

  // Port 1 is privileged and unused: the connection is refused at once
  // rather than hanging, so this asserts on the error path and not on a
  // timeout. The black-holed case below is the other half.
  unreachable = probePool("postgresql://postgres@127.0.0.1:1/vigil");

  // A migrations folder that stops one entry short of this build. One,
  // not ten: the check has to be exact, and a test that withheld a
  // third of the journal would pass against a check that only compared
  // rough counts.
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const kept = journal.entries.slice(0, -1);
  withheld = journal.entries[journal.entries.length - 1]!.tag;

  partialFolder = await mkdtemp(path.join(tmpdir(), "vigil-partial-"));
  await mkdir(path.join(partialFolder, "meta"), { recursive: true });
  for (const entry of kept) {
    await copyFile(
      path.join(MIGRATIONS, `${entry.tag}.sql`),
      path.join(partialFolder, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    path.join(partialFolder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: kept }),
  );
  const migrator = new Pool({ connectionString: scratchUrl(url, PARTIAL_DB) });
  try {
    await migrate(drizzle(migrator), { migrationsFolder: partialFolder });
  } finally {
    await migrator.end();
  }
}, 120_000);

afterAll(async () => {
  await empty?.end().catch(() => {});
  await partial?.end().catch(() => {});
  await unreachable?.end().catch(() => {});
  if (partialFolder) await rm(partialFolder, { recursive: true, force: true });
  await admin?.query(`DROP DATABASE IF EXISTS "${EMPTY_DB}" WITH (FORCE)`);
  await admin?.query(`DROP DATABASE IF EXISTS "${PARTIAL_DB}" WITH (FORCE)`);
  await admin?.end();
});

/** The suite's own database, probed through a pool of its own so the
 * counters below belong to this test and not to the ORM. */
let healthy: Pool;
beforeAll(() => {
  healthy = probePool(process.env.DATABASE_URL!);
});
afterAll(async () => {
  await healthy?.end().catch(() => {});
});

/**
 * Runs one route handler with the endpoint pointed at a chosen pool, so
 * the HTTP contract — the status code and the body an orchestrator
 * actually reads — is asserted on the failing states too, not only on
 * the happy one.
 *
 * Only the pool argument is substituted; everything inside
 * `@/lib/readiness` is the real implementation.
 */
async function callRoute(
  pool: Pool,
  load: () => Promise<{ GET: () => Response | Promise<Response> }>,
): Promise<Response> {
  vi.resetModules();
  vi.doMock("@/lib/readiness", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/readiness")>();
    return {
      ...actual,
      readinessResponse: () => actual.readinessResponse(pool),
    };
  });
  try {
    const route = await load();
    return await route.GET();
  } finally {
    vi.doUnmock("@/lib/readiness");
    vi.resetModules();
  }
}

const ready = () => import("@/app/api/ready/route");
const health = () => import("@/app/api/health/route");

async function bodyOf(response: Response): Promise<unknown> {
  return response.json();
}

describe("liveness", () => {
  it("answers 200 with no database at all", async () => {
    // The route imports nothing, so there is nothing to point at a
    // database and nothing to mock. That is the whole assertion: it
    // answers while Postgres is unreachable because it never asks.
    const route = await import("@/app/api/live/route");
    const response = await route.GET();
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not depend on the database module, even transitively", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src", "app", "api", "live", "route.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe("readiness", () => {
  it("is unavailable when Postgres cannot be reached", async () => {
    expect(await checkReadiness(unreachable)).toEqual({
      ready: false,
      reason: "unreachable",
    });

    const response = await callRoute(unreachable, ready);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ status: "unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("is unavailable against a reachable but empty database", async () => {
    // Proof that the old check would have passed here.
    const { rows } = await empty.query<{ one: number }>("select 1 as one");
    expect(rows[0]).toEqual({ one: 1 });

    expect(await checkReadiness(empty)).toEqual({
      ready: false,
      reason: "unmigrated",
    });

    const response = await callRoute(empty, ready);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ status: "unavailable" });
  });

  it("is unavailable against a partially migrated database", async () => {
    const { rows } = await partial.query<{ applied: string }>(
      "select count(*)::text as applied from drizzle.__drizzle_migrations",
    );
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8"),
    ) as Journal;
    // One short, and the ledger says so — this is a real interrupted
    // migration run, not a deleted row.
    expect(Number(rows[0]!.applied)).toBe(journal.entries.length - 1);
    expect(withheld).toBe(journal.entries[journal.entries.length - 1]!.tag);

    expect(await checkReadiness(partial)).toEqual({
      ready: false,
      reason: "incomplete",
    });

    const response = await callRoute(partial, ready);
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ status: "unavailable" });
  });

  it("is ready against a fully migrated database", async () => {
    expect(await checkReadiness(healthy)).toEqual({ ready: true });

    const response = await callRoute(healthy, ready);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says nothing about which failure it was", async () => {
    for (const pool of [unreachable, empty, partial]) {
      const response = await callRoute(pool, ready);
      const text = await response.text();
      expect(text).toBe(JSON.stringify({ status: "unavailable" }));
    }
  });

  it("gives the connection back after every one of them", async () => {
    // The states that succeed and the states that fail alike: a probe
    // that answered correctly and kept the client would exhaust its own
    // pool in three ticks.
    for (const pool of [healthy, empty, partial, unreachable]) {
      await checkReadiness(pool);
      expect({
        total: pool.totalCount,
        waiting: pool.waitingCount,
      }).toEqual({ total: pool.idleCount, waiting: 0 });
    }
  });
});

describe("/api/health, the compatibility alias", () => {
  it("still answers the exact bytes its callers grep for", async () => {
    const response = await callRoute(healthy, health);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ status: "ok" }));
  });

  it("answers readiness, not liveness", async () => {
    for (const pool of [unreachable, empty, partial]) {
      const aliased = await callRoute(pool, health);
      const canonical = await callRoute(pool, ready);
      expect(aliased.status).toBe(canonical.status);
      expect(await aliased.text()).toBe(await canonical.text());
      expect(aliased.status).toBe(503);
    }
  });
});

/**
 * A Postgres that accepts the connection and then says nothing, and what
 * the probe leaves behind after being asked repeatedly.
 *
 * This is the failure a connection-refused test cannot stand in for.
 * Refused is instant and lands in the error path; a black hole completes
 * the TCP handshake, swallows the startup packet and never answers.
 * Bounding only the HTTP response is not enough there — the response
 * settles and the connection does not, so every probe leaves a socket
 * behind. Measured on the application's pool options, five probes left
 * five clients open with nothing to reap them, and at `max` a pool spent
 * that way stops serving the thing it was borrowed from.
 *
 * The gate here is a switchable TCP proxy on ONE port: black hole first,
 * then a forwarder to the real Postgres. The pool never learns, is never
 * rebuilt and is never re-pointed — which is what makes the last case a
 * recovery rather than a restart.
 */
describe("readiness against a black-holed Postgres", () => {
  let gate: Server;
  let mode: "blackhole" | "forward" = "blackhole";
  const held: Socket[] = [];
  const forwarded: { inbound: Socket; outbound: Socket }[] = [];
  let pool: Pool;
  let upstream: { host: string; port: number };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    upstream = {
      host: url.hostname,
      port: Number(url.port || 5432),
    };

    gate = createServer((socket) => {
      socket.on("error", () => {});
      if (mode === "blackhole") {
        // Accepted, and that is all. No bytes in either direction.
        held.push(socket);
        return;
      }
      const out = tcpConnect(upstream);
      out.on("error", () => socket.destroy());
      socket.pipe(out);
      out.pipe(socket);
      forwarded.push({ inbound: socket, outbound: out });
    });
    await new Promise<void>((resolve) => gate.listen(0, "127.0.0.1", resolve));
    const address = gate.address();
    if (typeof address === "string" || address === null) {
      throw new Error("the gate did not report a port");
    }
    const through = new URL(url.toString());
    through.hostname = "127.0.0.1";
    through.port = String(address.port);
    pool = probePool(through.toString());
  });

  afterAll(async () => {
    for (const socket of held) socket.destroy();
    for (const pair of forwarded) {
      pair.inbound.destroy();
      pair.outbound.destroy();
    }
    await pool?.end().catch(() => {});
    await new Promise<void>((resolve) => gate?.close(() => resolve()));
  });

  /** Stops relaying on connections that are already established, so a
   * statement issued on one of them is never answered. */
  function stallEstablished(): void {
    for (const pair of forwarded) {
      pair.inbound.unpipe(pair.outbound);
      pair.outbound.unpipe(pair.inbound);
    }
  }

  /** Nothing checked out, nothing queued, nothing half-open. */
  const baseline = () => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });

  /**
   * The counters once they have stopped moving, or after `budgetMs` if
   * they never do.
   *
   * Polled rather than sampled after a fixed pause, and the difference
   * matters in both directions. pg removes a timed-out client from
   * `_clients` in the connect callback, a tick after the caller has
   * already been rejected, so a single sample under load reads a
   * connection that is on its way out as one that leaked. A pool that
   * genuinely leaks never reaches baseline at all, however long this
   * waits - measured on the unbounded options, the counters sat at
   * `total=10 waiting=2` thirty seconds later and did not move again.
   */
  async function settled(budgetMs = 5_000) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const now = baseline();
      if (now.total === 0 && now.idle === 0 && now.waiting === 0) return now;
      if (Date.now() >= deadline) return now;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("has a budget under the healthcheck that consumes it, and bounds beneath that", () => {
    // `docker-compose.yml` gives the app's healthcheck `timeout: 5s`,
    // and that has to cover starting node and issuing the request too.
    expect(READINESS_TIMEOUT_MS).toBeLessThan(5_000);
    // The connection bound is what actually releases, so it has to fire
    // first. An outer deadline that won the race would settle the
    // response and leave the socket exactly where it was.
    expect(READINESS_POOL_OPTIONS.connectionTimeoutMillis).toBeLessThan(
      READINESS_TIMEOUT_MS,
    );
    expect(pool.options.max).toBe(READINESS_POOL_OPTIONS.max);
  });

  it("starts from a pool with nothing in it", () => {
    expect(baseline()).toEqual({ total: 0, idle: 0, waiting: 0 });
  });

  it("answers 503 to every sequential probe, and keeps no connection", async () => {
    // Three, which is more than `max`. Sequentially, so a leak has a
    // whole probe's worth of time to become visible before the next.
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const response = await readinessResponse(pool);
      const elapsed = Date.now() - started;

      expect(`probe ${i}: ${response.status}`).toBe(`probe ${i}: 503`);
      expect(await bodyOf(response)).toEqual({ status: "unavailable" });
      expect(`probe ${i} took ${elapsed}ms`).toBe(
        elapsed < 5_000 ? `probe ${i} took ${elapsed}ms` : "under 5000ms",
      );
      expect(await settled()).toEqual({ total: 0, idle: 0, waiting: 0 });
    }
  }, 40_000);

  it("answers 503 to every concurrent probe, and returns to baseline", async () => {
    // Five at once against a pool of two: three of them are refused by
    // the queue rather than by a socket, and that path has to release as
    // well. Before this change the same five would have left five
    // connections behind and a permanently non-empty waiting queue.
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => readinessResponse(pool)),
    );
    const elapsed = Date.now() - started;

    expect(responses.map((r) => r.status)).toEqual([503, 503, 503, 503, 503]);
    for (const response of responses) {
      expect(await bodyOf(response)).toEqual({ status: "unavailable" });
    }
    expect(elapsed).toBeLessThan(5_000);

    expect(await settled()).toEqual({ total: 0, idle: 0, waiting: 0 });
  }, 40_000);

  it("says the same thing in the body as a refused connection does", async () => {
    const stalled = await (await readinessResponse(pool)).text();
    const refused = await (await readinessResponse(unreachable)).text();
    expect(stalled).toBe(refused);
  }, 20_000);

  it("recovers as soon as a real Postgres is behind the port", async () => {
    // Same pool, same connection string, no restart: the only thing that
    // changed is what is on the other end of the socket. A probe that
    // had leaked would find its own pool full here and stay unavailable
    // long after the database came back.
    mode = "forward";
    for (const socket of held.splice(0)) socket.destroy();

    const started = Date.now();
    const response = await readinessResponse(pool);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ status: "ok" });
    expect(elapsed).toBeLessThan(2_000);

    // And it is still ready on the next tick, from a pooled connection
    // rather than a fresh one.
    expect((await readinessResponse(pool)).status).toBe(200);
    expect(pool.totalCount).toBeLessThanOrEqual(READINESS_POOL_OPTIONS.max);
    expect(pool.waitingCount).toBe(0);
  }, 40_000);

  it("destroys a connection whose statement went unanswered", async () => {
    // The other half of the release contract, and the half
    // `connectionTimeoutMillis` cannot reach: here the connection is
    // already established and pooled, so the probe gets past connect and
    // then the answer never comes. A client abandoned mid-statement has
    // an unknown protocol state and a query that may still be on the
    // wire; handing it to the next probe would make the next probe wrong
    // rather than merely slow. `release(err)` destroys it instead.
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    stallEstablished();

    const started = Date.now();
    const response = await readinessResponse(pool);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ status: "unavailable" });
    expect(elapsed).toBeLessThan(5_000);
    // Destroyed, not returned: the pool is empty rather than holding an
    // idle client nobody can use.
    expect(await settled()).toEqual({ total: 0, idle: 0, waiting: 0 });
  }, 40_000);
});

/**
 * The outer deadline, on its own.
 *
 * It is no longer what bounds the database work — `connectionTimeout
 * Millis` and `query_timeout` are, and they release what they bound. It
 * stays because they are pg's promises rather than ours: a path through
 * the driver that settles neither would otherwise hang the probe past
 * the healthcheck that is waiting on it. Tested here with a pool that
 * never answers at all, which no combination of pg options can rescue.
 */
describe("the deadline behind the bounds", () => {
  it("answers unavailable when the pool itself never settles", async () => {
    // Not a Pool, deliberately: a real one cannot be made to hang now,
    // which is the point of the change. This is the escape hatch being
    // exercised rather than assumed.
    const wedged = {
      connect: () => new Promise<never>(() => {}),
    } as unknown as Pool;

    const started = Date.now();
    const state = await checkReadiness(wedged);
    const elapsed = Date.now() - started;

    expect(state).toEqual({ ready: false, reason: "timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);
});
