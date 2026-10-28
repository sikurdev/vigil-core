import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import type { DbClient } from "@/db";
import {
  incidentEvents,
  incidents,
  monitorChecks,
  monitors,
} from "@/db/schema";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/modules/audit";
import { stampFact } from "@/modules/ledger/service";
import {
  recordDispatchIntent,
  resolvedIntent,
} from "@/modules/notifications/intents";

import type { CheckResult } from "./check";
import {
  describeMonitorTarget,
  maskTargetSecret,
  redactTargetCredentials,
  restoreTargetSecret,
} from "./spec";
import { nextEvaluationAt, type RecentObservation } from "./scheduling";
import { MEASURED, round2, uptimeSegments, type UptimeResult } from "./uptime";
import type { CreateMonitorInput, UpdateMonitorInput } from "./schemas";
import {
  advanceFailureRun,
  reconcile,
  type Reconciliation,
} from "./status-controller";
import { pushEndpointUrl } from "./heartbeat";
import {
  AGGREGATE_CHECK_TYPE_IDS,
  checkTypeKind,
  UNSCHEDULED_CHECK_TYPE_IDS,
} from "./types/catalog";
import { newPushToken } from "./types/specs/push";
import type { Verdict } from "./types/conditions";
import { isScheduledKind } from "./types/contract";
import { monitorColumnsFor } from "./types/persist";
import { requireSpec } from "./types/specs";

export type Monitor = typeof monitors.$inferSelect;
export type MonitorCheck = typeof monitorChecks.$inferSelect;

interface Actor {
  organizationId: string;
  userId: string;
}

export interface MonitorListItem extends Monitor {
  uptime24hPct: number | null;
  avgResponseMs: number | null;
}

export async function listMonitors(
  db: DbClient,
  organizationId: string,
): Promise<MonitorListItem[]> {
  const rows = await db
    .select()
    .from(monitors)
    .where(eq(monitors.organizationId, organizationId))
    .orderBy(asc(monitors.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((monitor) => monitor.id);
  const now = new Date();
  const uptime = await uptimeByMonitor(db, ids, hoursAgo(now, 24), now);

  // Response time stays a plain mean of the samples that measured one.
  // It is not duration-weighted and should not be: weighting a latency
  // average by how long each sample stood for answers a question nobody
  // asked, and the honest version of "typical response time" is a
  // percentile, which is its own change.
  const latency = await db
    .select({
      monitorId: monitorChecks.monitorId,
      avgResponseMs: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${monitorChecks.ok}))`,
    })
    .from(monitorChecks)
    .where(
      and(
        inArray(monitorChecks.monitorId, ids),
        gte(monitorChecks.checkedAt, sql`now() - interval '24 hours'`),
      ),
    )
    .groupBy(monitorChecks.monitorId);
  const latencyById = new Map(
    latency.map((row) => [row.monitorId, row.avgResponseMs]),
  );

  return rows.map((monitor) => ({
    ...monitor,
    // Redacted here rather than at each page, because every caller of
    // this function renders it and none of them dials it. A `postgres`
    // or `sqlserver` target holds a password — the catalog's own
    // placeholder tells the operator to put one there — and the four
    // pages that list monitors were putting it in the page source of
    // anyone who could open them, including a viewer, whose statements
    // are `{}`. Truncating it in CSS is not redaction.
    //
    // The probe path does not come through here. `toCheckSpec` reads the
    // row, so the target that gets dialled is still the whole one.
    url: redactTargetCredentials(monitor.url),
    uptime24hPct: uptime.get(monitor.id)?.uptimePct ?? null,
    avgResponseMs:
      latencyById.get(monitor.id) === null ||
      latencyById.get(monitor.id) === undefined
        ? null
        : Number(latencyById.get(monitor.id)),
  }));
}

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

/**
 * Duration-weighted uptime for a set of monitors over one window.
 *
 * Sums the segments `uptimeSegments` emits: total for the denominator,
 * `filter (where ok)` for the numerator. Monitors with no covered time
 * are absent from the map, which callers render as "no data" rather than
 * as 0%.
 */
export async function uptimeByMonitor(
  db: DbClient,
  monitorIds: readonly string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Map<string, UptimeResult>> {
  if (monitorIds.length === 0) return new Map();
  const segments = uptimeSegments(monitorIds, windowStart, windowEnd);
  const { rows } = await db.execute<{
    monitor_id: string;
    up_ms: string | null;
    covered_ms: string | null;
  }>(sql`
    select
      monitor_id,
      sum(duration_ms) filter (where ok) as up_ms,
      sum(duration_ms) as covered_ms
    from (${segments}) seg
    group by monitor_id
  `);

  const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
  const result = new Map<string, UptimeResult>();
  for (const row of rows) {
    const coveredMs = Number(row.covered_ms ?? 0);
    const upMs = Number(row.up_ms ?? 0);
    result.set(row.monitor_id, {
      coveredMs,
      upMs,
      uncoveredMs: windowMs - coveredMs,
      uptimePct: coveredMs === 0 ? null : round2((upMs / coveredMs) * 100),
    });
  }
  return result;
}

export interface UptimeWindow {
  label: "24h" | "7d" | "30d";
  uptimePct: number | null;
  avgResponseMs: number | null;
  /**
   * How much of the window an observation actually vouched for. A 100%
   * headline over 40% coverage is a different statement from one over
   * full coverage, and the detail page says so rather than letting the
   * reader assume.
   */
  coveragePct: number;
}

export interface MonitorDetail {
  monitor: Monitor;
  windows: UptimeWindow[];
  recentChecks: MonitorCheck[];
}

export async function getMonitorDetail(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<MonitorDetail> {
  const monitor = await findMonitorOrThrow(db, organizationId, monitorId);
  const now = new Date();

  const [aggregate] = await db
    .select({
      avg24h: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("24 hours")}))`,
      avg7d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("7 days")}))`,
      avg30d: sql<
        number | null
      >`round(avg(${monitorChecks.responseTimeMs}) filter (where ${okWithin("30 days")}))`,
    })
    .from(monitorChecks)
    // Bounded, unlike the pre-1.13 version: the widest window is 30 days,
    // so scanning the monitor's whole retained history was work thrown
    // away every page load.
    .where(and(eq(monitorChecks.monitorId, monitorId), within("30 days")));

  const recentChecks = await db.query.monitorChecks.findMany({
    where: eq(monitorChecks.monitorId, monitorId),
    orderBy: [desc(monitorChecks.checkedAt)],
    limit: 60,
  });

  const spans: { label: UptimeWindow["label"]; hours: number }[] = [
    { label: "24h", hours: 24 },
    { label: "7d", hours: 24 * 7 },
    { label: "30d", hours: 24 * 30 },
  ];
  const averages = {
    "24h": aggregate?.avg24h,
    "7d": aggregate?.avg7d,
    "30d": aggregate?.avg30d,
  };

  const windows: UptimeWindow[] = [];
  for (const span of spans) {
    const start = hoursAgo(now, span.hours);
    const measured = await uptimeByMonitor(db, [monitorId], start, now);
    const result = measured.get(monitorId);
    const windowMs = now.getTime() - start.getTime();
    const avg = averages[span.label];
    windows.push({
      label: span.label,
      uptimePct: result?.uptimePct ?? null,
      avgResponseMs: avg === null || avg === undefined ? null : Number(avg),
      coveragePct: result ? round2((result.coveredMs / windowMs) * 100) : 0,
    });
  }

  return {
    monitor: {
      ...monitor,
      // Masked, not stripped. This row reaches the detail page, which
      // shows the target and also hands it to the edit dialog — a client
      // component, so whatever is here lands in the page source of
      // anyone who can open the monitor, viewers included.
      //
      // Stripping the userinfo outright would be safe and wrong: the
      // operator who opens the dialog to change a port would save the
      // target back with its username gone. `maskTargetSecret` keeps
      // everything that is not the secret, and `updateMonitor` puts the
      // stored password back when the mask comes home untouched. The
      // display paths strip what is left.
      //
      // The probe never reads this. `toCheckSpec` builds from the row.
      url: maskTargetSecret(monitor.url),
    },
    windows,
    recentChecks,
  };
}

function within(interval: string) {
  // Carries the MEASURED filter, so it applies to the denominator and
  // the numerator alike — `okWithin` is built from this.
  return sql`${monitorChecks.checkedAt} > now() - ${sql.raw(`interval '${interval}'`)} and ${MEASURED}`;
}

function okWithin(interval: string) {
  return sql`${within(interval)} and ${monitorChecks.ok}`;
}

/**
 * Refuses a group membership that could not mean anything.
 *
 * Four rules, and the first two are the ones that matter. Membership
 * crosses no tenant: a monitor joining another organization's group
 * would publish its status inside that group's rollup, on that
 * organization's status page. And a monitor cannot be inside itself, at
 * any distance — a cycle makes `refreshGroups` walk forever and makes
 * "what is this group's state" a question with no answer.
 *
 * Checked here rather than by a database constraint because Postgres
 * cannot express "no cycles in this self-reference" without a trigger,
 * and a trigger would be a second place the rule lives.
 */
async function assertParent(
  db: DbClient,
  organizationId: string,
  monitorId: string | null,
  parentId: string,
): Promise<void> {
  if (parentId === monitorId) {
    throw new ConflictError("A monitor cannot be a member of itself.");
  }

  const parent = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, parentId),
      eq(monitors.organizationId, organizationId),
    ),
  });
  if (!parent) throw new NotFoundError("That group does not exist.");
  if (checkTypeKind(parent.checkType) !== "aggregate") {
    throw new ConflictError(
      `"${parent.name}" is not a group, so it cannot have members.`,
    );
  }

  // Walk to the root. `monitorId` is null on create, in which case
  // there is nothing to meet, but the walk still bounds a chain that a
  // restored backup could have left cyclic.
  let cursor: string | null = parent.parentId;
  for (let step = 0; cursor !== null && step < MAX_GROUP_NESTING; step += 1) {
    if (cursor === monitorId) {
      throw new ConflictError(
        "That would put this group inside one of its own members.",
      );
    }
    const next: { parentId: string | null } | undefined =
      await db.query.monitors.findFirst({
        where: eq(monitors.id, cursor),
        columns: { parentId: true },
      });
    cursor = next?.parentId ?? null;
  }
}

/** How deeply groups may nest. Matches the bound `outcome.ts` walks with. */
const MAX_GROUP_NESTING = 8;

/**
 * When a freshly created monitor is first due.
 *
 * Immediately for the kinds the scheduler owns: a monitor nobody has
 * checked has nothing to schedule around, and waiting one interval to
 * find out the URL was wrong is the worst possible first impression.
 *
 * Null for the kinds it does not. A group's state is derived when a
 * member reports and a manual one's when a person says so, and leaving
 * a due timestamp on either would put a row in front of the scheduler
 * on every tick, forever, for it to decide again that there is nothing
 * to do.
 */
function initialEvaluationAt(checkType: string): Date | null {
  return isScheduledKind(checkTypeKind(checkType)) ? new Date() : null;
}

export async function createMonitor(
  db: DbClient,
  actor: Actor,
  input: CreateMonitorInput,
): Promise<Monitor> {
  const spec = requireSpec(input.checkType);
  return db.transaction(async (tx) => {
    if (input.parentId) {
      await assertParent(tx, actor.organizationId, null, input.parentId);
    }
    const [monitor] = await tx
      .insert(monitors)
      .values({
        organizationId: actor.organizationId,
        createdBy: actor.userId,
        name: input.name,
        checkType: input.checkType,
        url: input.url,
        parentId: input.parentId ?? null,
        intervalSeconds: input.intervalSeconds,
        timeoutMs: input.timeoutMs,
        degradedThresholdMs: input.degradedThresholdMs,
        failureWindowSeconds: input.failureWindowSeconds,
        nextEvaluationAt: initialEvaluationAt(input.checkType),
        ...monitorColumnsFor(spec, input),
      })
      .returning();
    if (!monitor) throw new Error("insert returned no row");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.created",
      targetType: "monitor",
      targetId: monitor.id,
      // An audit entry is read by anyone who can read the audit trail,
      // exported with it, and kept after the monitor is gone. Recording
      // the credential here would outlive every other copy of it.
      metadata: {
        name: monitor.name,
        url: redactTargetCredentials(monitor.url),
      },
    });
    return monitor;
  });
}

/**
 * A copy of an existing monitor, paused, with a name the operator can
 * find.
 *
 * Cloning exists because a journey is the first thing in this product
 * that is genuinely expensive to author. Forty steps of a checkout flow
 * are a morning's work, and "the same journey against staging" should
 * not be that morning again - it should be a copy with one field
 * changed. It applies to every type because there is no reason it should
 * not: a copy of a Postgres monitor pointed at the replica is the same
 * saving in miniature.
 *
 * Three decisions are load-bearing.
 *
 * **The config is copied server-side, never through the client.** A
 * clone assembled in the browser would have to send back what the
 * browser was given, and what the browser was given has `SECRET_MASK`
 * where every credential was. The copy would silently lose them. Reading
 * the row here means the credentials come along and never leave the
 * server.
 *
 * **The copy is paused.** A clone is an unfinished edit by definition -
 * nobody duplicates a monitor in order to watch the same target twice -
 * and an unpaused copy would immediately double the request rate against
 * whatever it was cloned from, and open its own incidents about it.
 *
 * **Provenance does not come along.** `import_source` and
 * `import_source_id` identify one row in somebody else's system, and two
 * rows claiming it would break the unique index that makes re-importing
 * safe. A clone is a new monitor that a person made here.
 */
export async function cloneMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    const source = await tx.query.monitors.findFirst({
      where: and(
        eq(monitors.id, monitorId),
        eq(monitors.organizationId, actor.organizationId),
      ),
    });
    if (!source) throw new NotFoundError("That monitor does not exist.");

    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      importSource: _importSource,
      importSourceId: _importSourceId,
      // Shadow mode is the bridge's, not the row's. A clone is a new
      // monitor a person made here, and carrying the flag would hand
      // them one that silently never pages, cannot join a status page,
      // and is swept into someone else's cutover.
      shadowBridgeId: _shadowBridgeId,
      // Restart memory belongs to the samples this row has seen. A
      // clone has seen none, and copying the hold would keep an
      // incident open on a monitor that has never been down.
      dockerState: _dockerState,
      ...carried
    } = source;

    const [monitor] = await tx
      .insert(monitors)
      .values({
        ...carried,
        createdBy: actor.userId,
        name: cloneName(source.name),
        paused: true,
        // Every observed state is left behind. A clone has never been
        // checked, and carrying the original's status would put a copy
        // on the dashboard reporting an outage it has no evidence for.
        currentStatus: "unknown",
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastCheckedAt: null,
        tlsDaysRemaining: null,
        nextEvaluationAt: null,
        dispatchClaimedUntil: null,
      })
      .returning();
    if (!monitor) throw new Error("insert returned no row");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.cloned",
      targetType: "monitor",
      targetId: monitor.id,
      metadata: { clonedFrom: source.id, name: monitor.name },
    });
    return monitor;
  });
}

/**
 * `Checkout (copy)`, then `Checkout (copy 2)`.
 *
 * Bounded rather than made unique against the table: names are not
 * unique in this product and never have been, so a query to avoid a
 * collision would be enforcing a constraint that does not exist. What
 * this avoids is `Checkout (copy) (copy) (copy)`, which is what a naive
 * suffix produces the third time somebody clones a clone.
 */
function cloneName(name: string): string {
  const match = /^(.*) \(copy(?: (\d+))?\)$/.exec(name);
  if (match === null) return `${name} (copy)`.slice(0, 100);
  const base = match[1] ?? name;
  const next = match[2] === undefined ? 2 : Number(match[2]) + 1;
  return `${base} (copy ${next})`.slice(0, 100);
}

export async function updateMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  input: UpdateMonitorInput,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    const existing = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    // The edit dialog is handed the target with its password masked, so
    // a save that did not retype the secret arrives carrying the
    // sentinel. Put the stored password back before anything reads the
    // target: `ruleChanged` compares it, the row stores it, and the
    // probe dials it. Resolving it here rather than at the three of them
    // is the same rule the config blob follows — the browser is never
    // given the credential, so it cannot be asked to send it back.
    const patch: UpdateMonitorInput =
      input.url === undefined
        ? input
        : { ...input, url: restoreTargetSecret(input.url, existing.url) };

    // Settings are normalised against the effective type, merging what
    // was submitted over what is stored. Doing it any other way means a
    // type switch can leave the previous type's settings behind.
    const checkType = patch.checkType ?? existing.checkType;
    const spec = requireSpec(checkType);

    if (patch.parentId) {
      await assertParent(tx, actor.organizationId, monitorId, patch.parentId);
    }

    // Turning a group into something else would leave its members
    // pointing at a monitor that no longer aggregates anything: they
    // would keep their membership, the group would stop deriving, and
    // nothing anywhere would say why. Refusing names the fix — empty it
    // first — instead of silently unpicking someone's structure.
    if (
      checkTypeKind(existing.checkType) === "aggregate" &&
      checkTypeKind(checkType) !== "aggregate"
    ) {
      const [members] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(monitors)
        .where(eq(monitors.parentId, monitorId));
      if ((members?.count ?? 0) > 0) {
        throw new ConflictError(
          `This group still has ${members?.count} member${members?.count === 1 ? "" : "s"}. Move them out before changing its type.`,
        );
      }
    }

    const columns = monitorColumnsFor(
      spec,
      {
        port: patch.port === undefined ? existing.port : patch.port,
        method: patch.method ?? existing.method,
        expectedStatusCode:
          patch.expectedStatusCode === undefined
            ? existing.expectedStatusCode
            : patch.expectedStatusCode,
        bodyKeyword:
          patch.bodyKeyword === undefined
            ? existing.bodyKeyword
            : patch.bodyKeyword,
        keywordAbsent: patch.keywordAbsent ?? existing.keywordAbsent,
        tlsCheck: patch.tlsCheck ?? existing.tlsCheck,
        tlsWarnDays: patch.tlsWarnDays ?? existing.tlsWarnDays,
        // The patch itself, not a value resolved against the row. The
        // flat columns above are all-or-nothing settings the form always
        // sends, so resolving them here is right; the config blob can
        // hold a credential the form was never given, so it is merged
        // field by field against what is stored.
        config: patch.config,
      },
      { checkType: existing.checkType, config: existing.config },
    );

    const [updated] = await tx
      .update(monitors)
      .set({
        ...patch,
        checkType,
        ...columns,
        // Editing the rule creates a new version of it. The old version
        // is never touched, so an observation recorded under it stays
        // interpretable — which is the whole point of versioning the
        // spec rather than mutating it in place.
        specVersion: ruleChanged(existing, input)
          ? existing.specVersion + 1
          : existing.specVersion,
        // A changed baseline should take effect now, not after the old
        // one elapses.
        ...(patch.intervalSeconds !== undefined &&
        patch.intervalSeconds !== existing.intervalSeconds
          ? { nextEvaluationAt: new Date() }
          : {}),
        // A type switch can move a monitor onto or off the scheduler.
        // Off, and a stale due timestamp would keep offering it to every
        // tick; on, and the null one it was left with reads as "never
        // evaluated", which `findDueMonitors` already treats as due —
        // stated anyway, so the column says what is true rather than
        // relying on two rules agreeing.
        ...(checkType !== existing.checkType
          ? { nextEvaluationAt: initialEvaluationAt(checkType) }
          : {}),
        // DELIBERATELY ABSENT: `firstFailureAt` is not reset when
        // `failureWindowSeconds` changes. It looks like an oversight and
        // is not.
        //
        // Measuring the run from its real start works in both
        // directions. Widening mid-outage extends the deadline from the
        // original failure — you asked for more tolerance and you get
        // it. Narrowing fires the incident immediately — you asked for
        // less, and you have already been failing that long.
        //
        // Resetting would break the second one: narrowing a window
        // during a live outage would restart the clock and *delay* an
        // incident that is already overdue. Making a monitoring product
        // slower to page in response to an operator asking it to be
        // faster is the one direction this must never move.
      })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.updated",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { fields: Object.keys(patch) },
    });
    return updated;
  });
}

export async function setMonitorPaused(
  db: DbClient,
  actor: Actor,
  monitorId: string,
  paused: boolean,
): Promise<Monitor> {
  return db.transaction(async (tx) => {
    const existing = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    const [updated] = await tx
      .update(monitors)
      // Unpausing starts from a clean slate. `firstFailureAt` is the
      // one that matters since 1.10.0: it is what the status controller
      // derives from, so leaving it set means the first failing check
      // after a week-long pause computes "failing for a week" and pages
      // immediately, skipping `failureWindowSeconds` entirely.
      // `consecutiveFailures` is now only informational, and
      // `nextEvaluationAt` has to move or a resumed monitor waits out a
      // schedule computed before the pause.
      //
      // `currentStatus: "unknown"` is load-bearing too, and looks like
      // the opposite. `deriveStatus` returns `previousStatus` for a
      // failing check inside the window, so leaving a `down` status on
      // the row means the first failing check after the resume derives
      // `down` again and opens an incident at once — the same skipped
      // window `firstFailureAt` is cleared to prevent. Verified by
      // removing this line: the monitor pages immediately.
      //
      // The cost is that a resumed monitor reads `unknown` until it is
      // measured again, and `getPublicStatusPage` compensates by asking
      // what the latest *observation* was rather than trusting this
      // column. That compensating rule has to treat a `down` verdict as
      // evidence as well as an `indeterminate` one — the clean slate
      // written here is exactly what makes a failing monitor's stored
      // status `unknown`, so a rule keyed on `indeterminate` alone
      // publishes a green banner over a live failure.
      .set({
        paused,
        consecutiveFailures: 0,
        currentStatus: "unknown",
        firstFailureAt: null,
        // Not `new Date()` unconditionally: a group or a manual monitor
        // that is resumed still has nothing for the scheduler to do, and
        // handing it a due timestamp would put it in front of every tick
        // from then on.
        nextEvaluationAt: initialEvaluationAt(existing.checkType),
      })
      .where(eq(monitors.id, monitorId))
      .returning();
    if (!updated) throw new NotFoundError("Monitor not found.");

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: paused ? "monitor.paused" : "monitor.resumed",
      targetType: "monitor",
      targetId: monitorId,
    });
    return updated;
  });
}

/**
 * Deletes a monitor and reports the group it was in, if any.
 *
 * The caller needs that id: the group's state was derived from a member
 * that no longer exists, and nothing else will ever tell it. Deleting a
 * *group* releases its members instead of taking them with it — see the
 * `ON DELETE SET NULL` on `monitors.parent_id`.
 */
export async function deleteMonitor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<{ releasedGroupId: string | null }> {
  return db.transaction(async (tx) => {
    const monitor = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );

    // Close this monitor's open incidents BEFORE the row goes.
    //
    // `incidents.monitor_id` is ON DELETE SET NULL, so deleting a
    // monitor mid-outage left its incident open with nothing pointing
    // at it: `resolveMonitorIncidents` selects by `monitor_id` and can
    // never reach it again, so the incident sat in the active list and
    // the dashboard count forever. Resolving it here, in the same
    // transaction as the delete, is the only moment the link still
    // exists - and it says why on the timeline rather than closing
    // silently.
    const orphaned = await tx
      .update(incidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        statusRevision: sql`${incidents.statusRevision} + 1`,
      })
      .where(
        and(
          eq(incidents.monitorId, monitorId),
          eq(incidents.organizationId, actor.organizationId),
          eq(incidents.source, "monitor"),
          ne(incidents.status, "resolved"),
        ),
      )
      .returning();
    for (const incident of orphaned) {
      await tx.insert(incidentEvents).values({
        incidentId: incident.id,
        type: "system",
        status: "resolved",
        message: `Resolved because the monitor "${monitor.name}" was deleted.`,
        internal: false,
        createdBy: actor.userId,
      });
      // And tell whoever was told it started.
      //
      // Closing the incident here fixed one bug and left another
      // untouched: nothing was ever announced. Channels heard no
      // `incident.resolved`, and status-page subscribers who had been
      // emailed "we are investigating" were left believing the outage
      // was still live - permanently, because after this transaction
      // there is no monitor to recover and no path that re-examines a
      // resolved incident. An operator tidying up a decommissioned
      // service silently stranded its public audience.
      if (!incident.notifiedAt) continue;
      await recordDispatchIntent(tx, {
        organizationId: actor.organizationId,
        causeKey: `incident:${incident.id}:incident.resolved`,
        kind: "incident",
        incidentId: incident.id,
        payload: resolvedIntent({
          incident,
          monitor: {
            id: monitor.id,
            name: monitor.name,
            url: monitor.url,
            currentStatus: monitor.currentStatus,
            checkType: monitor.checkType,
          },
          monitorTarget: describeMonitorTarget(monitor),
        }),
      });
    }

    await tx.delete(monitors).where(eq(monitors.id, monitorId));
    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.deleted",
      targetType: "monitor",
      targetId: monitorId,
      metadata: {
        name: monitor.name,
        url: redactTargetCredentials(monitor.url),
        incidentsResolved: orphaned.length,
      },
    });
    return { releasedGroupId: monitor.parentId };
  });
}

/**
 * Every group in an organization, for the membership picker.
 *
 * `excludeId` keeps a group out of its own list. Putting a group inside
 * itself is refused by `assertParent` anyway, but offering the option
 * and then rejecting it is a worse form to fill in than one that never
 * offered it.
 */
export async function listGroups(
  db: DbClient,
  organizationId: string,
  excludeId?: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await db
    .select({ id: monitors.id, name: monitors.name })
    .from(monitors)
    .where(
      and(
        eq(monitors.organizationId, organizationId),
        inArray(monitors.checkType, [...AGGREGATE_CHECK_TYPE_IDS]),
      ),
    )
    .orderBy(asc(monitors.name));
  return excludeId === undefined
    ? rows
    : rows.filter((row) => row.id !== excludeId);
}

/** The push endpoint of one monitor, for an operator who may edit it. */
export async function pushEndpointFor(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<string> {
  const monitor = await findMonitorOrThrow(db, actor.organizationId, monitorId);
  return pushEndpointUrl(pushTokenOf(monitor));
}

/**
 * Issues a new token for a push monitor.
 *
 * Destructive by design, and the only honest response to "the token
 * leaked": whatever holds the old one stops being able to speak for
 * this monitor the moment this returns. The audit entry records that it
 * happened without recording the value.
 */
export async function regeneratePushToken(
  db: DbClient,
  actor: Actor,
  monitorId: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const monitor = await findMonitorOrThrow(
      tx,
      actor.organizationId,
      monitorId,
    );
    if (checkTypeKind(monitor.checkType) !== "passive") {
      throw new ConflictError("This monitor has no push endpoint.");
    }

    const token = newPushToken();
    const config = requireSpec(monitor.checkType).storedSchema.parse({
      ...(typeof monitor.config === "object" && monitor.config !== null
        ? monitor.config
        : {}),
      token,
    });

    await tx.update(monitors).set({ config }).where(eq(monitors.id, monitorId));

    await writeAudit(tx, {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: "monitor.push_token_regenerated",
      targetType: "monitor",
      targetId: monitorId,
      metadata: { name: monitor.name },
    });
    return pushEndpointUrl(token);
  });
}

function pushTokenOf(monitor: Monitor): string {
  const config = monitor.config;
  const token =
    typeof config === "object" && config !== null && "token" in config
      ? (config as { token?: unknown }).token
      : undefined;
  if (typeof token !== "string" || token.length === 0) {
    // Only reachable for a monitor whose type is not push, or whose
    // config predates the token — both are operator-visible mistakes
    // rather than states to paper over with a generated value nobody
    // stored.
    throw new ConflictError("This monitor has no push endpoint.");
  }
  return token;
}

export interface RecordedCheck {
  monitor: Monitor;
  /** What the controller says should be true now. */
  reconciliation: Reconciliation;
}

/** How many observations the scheduling policy is shown. */
const RECENT_OBSERVATION_WINDOW = 10;

/** Fields that make up the rule, as opposed to its labelling or routing. */
function ruleChanged(existing: Monitor, input: UpdateMonitorInput): boolean {
  const compare: Array<[unknown, unknown]> = [
    [input.checkType, existing.checkType],
    [input.url, existing.url],
    [input.port, existing.port],
    [input.method, existing.method],
    [input.intervalSeconds, existing.intervalSeconds],
    [input.timeoutMs, existing.timeoutMs],
    [input.degradedThresholdMs, existing.degradedThresholdMs],
    [input.expectedStatusCode, existing.expectedStatusCode],
    [input.bodyKeyword, existing.bodyKeyword],
    [input.keywordAbsent, existing.keywordAbsent],
    [input.tlsCheck, existing.tlsCheck],
    [input.tlsWarnDays, existing.tlsWarnDays],
    [input.failureWindowSeconds, existing.failureWindowSeconds],
  ];
  if (
    compare.some(([next, current]) => next !== undefined && next !== current)
  ) {
    return true;
  }
  return (
    input.config !== undefined &&
    JSON.stringify(input.config ?? null) !==
      JSON.stringify(existing.config ?? null)
  );
}

/**
 * The exact content an observation is hashed over.
 *
 * Exported because a verifier has to reconstruct the same bytes the
 * writer hashed, from the stored columns. If the two ever disagree the
 * chain is unverifiable, so there is one function and both sides call
 * it — the CI chain test is what keeps that honest.
 */
export function observationClaim(outcome: CheckResult, checkedAt: Date) {
  return {
    // `ok` and `checkedAt` are the two columns every uptime number is
    // computed from, so they are exactly the two an edit would target.
    // Both were derivable from the hashed verdict and clock, but
    // nothing cross-checked them — `UPDATE monitor_checks SET ok = true`
    // left the chain verifying happily. Rows written today are what a
    // 2.0 verifier reads, so this is cheap now and impossible later.
    ok: outcome.ok,
    checkedAt: checkedAt.toISOString(),
    verdict: outcome.verdict,
    failureClass: outcome.failureClass,
    statusCode: outcome.statusCode,
    responseTimeMs: outcome.responseTimeMs,
    error: outcome.error,
    facts: outcome.facts,
  };
}

export interface RecordCheckOptions {
  /**
   * The actor whose ledger chain this observation joins. Optional so a
   * test or a one-off script can record without an identity; production
   * always supplies one.
   */
  actorId?: string;
  now?: Date;
}

/**
 * Persists an observation and advances the monitor's derived state.
 *
 * Returns what the status controller concluded rather than transition
 * flags. The caller acts on that conclusion, and because the conclusion
 * is a function of current state rather than of a change, acting on it
 * twice is harmless and never acting on the intervening state is
 * survivable — which is the whole reason for the change.
 */
export async function recordCheckOutcome(
  db: DbClient,
  monitor: Monitor,
  outcome: CheckResult,
  options: RecordCheckOptions = {},
): Promise<RecordedCheck> {
  const now = options.now ?? new Date();
  const verdict: Verdict = outcome.verdict;

  const firstFailureAt = advanceFailureRun(
    monitor.firstFailureAt,
    verdict,
    now,
  );
  const reconciliation = reconcile(
    { failureWindowSeconds: monitor.failureWindowSeconds },
    {
      verdict,
      firstFailureAt,
      previousStatus: monitor.currentStatus,
      now,
      // A Docker restart loop, or unhealthy counted as down, sets this
      // until a later sample is cleanly up. Degraded is not that sample.
      degradedResolves: outcome.dockerState?.holdResolve !== true,
    },
  );

  const consecutiveFailures =
    verdict === "down"
      ? monitor.consecutiveFailures + 1
      : verdict === "indeterminate"
        ? monitor.consecutiveFailures
        : 0;

  const [updated] = await db.transaction(async (tx) => {
    const stamp = options.actorId
      ? await stampFact(
          tx,
          {
            actorId: options.actorId,
            kind: "observation",
            subject: monitor.id,
            specVersion: monitor.specVersion,
            claim: observationClaim(outcome, now),
          },
          now.getTime(),
        )
      : null;

    await tx.insert(monitorChecks).values({
      monitorId: monitor.id,
      checkedAt: now,
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      error: outcome.error,
      verdict,
      failureClass: outcome.failureClass,
      facts: outcome.facts,
      ...(stamp
        ? {
            actorId: stamp.actorId,
            hlc: stamp.hlc,
            seq: stamp.seq,
            prevHash: stamp.prevHash,
            hash: stamp.hash,
            specVersion: stamp.specVersion,
          }
        : {}),
    });

    // The policy hook's inputs, read back inside the same transaction so
    // it sees the observation just written.
    const recent: RecentObservation[] = await tx
      .select({ ok: monitorChecks.ok, verdict: monitorChecks.verdict })
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, monitor.id))
      .orderBy(desc(monitorChecks.checkedAt), desc(monitorChecks.id))
      .limit(RECENT_OBSERVATION_WINDOW)
      .then((rows) =>
        rows.map((row) => ({
          ok: row.ok,
          verdict: (row.verdict as Verdict | null) ?? undefined,
        })),
      );

    return (
      tx
        .update(monitors)
        .set({
          consecutiveFailures,
          firstFailureAt,
          currentStatus: reconciliation.status,
          lastCheckedAt: now,
          // The claim is spent the moment its check lands. Left to
          // expire instead, a monitor on an interval shorter than the
          // lease would sit unselectable after being probed - a 30s
          // monitor would be checked, then ignored for the remaining
          // sixty seconds of a ninety-second claim, and settle at the
          // lease rather than at its own cadence.
          dispatchClaimedUntil: null,
          // A kind the scheduler does not own gets no next evaluation.
          // The adaptive policy is about when to *ask* again, and for a
          // derived or declared state there is nobody to ask — the next
          // observation happens when a member reports or a person says
          // so, and a timestamp here would only offer the row to every
          // tick for the scheduler to reject again.
          nextEvaluationAt: isScheduledKind(checkTypeKind(monitor.checkType))
            ? nextEvaluationAt(
                {
                  intervalSeconds: monitor.intervalSeconds,
                  // The status just derived, not the stale one on the row.
                  currentStatus: reconciliation.status,
                },
                recent,
                now,
              )
            : null,
          // Only overwrite when this check actually measured the cert.
          ...(outcome.tlsDaysRemaining === undefined
            ? {}
            : { tlsDaysRemaining: outcome.tlsDaysRemaining }),
          ...(outcome.dockerState === undefined
            ? {}
            : { dockerState: outcome.dockerState }),
        })
        // `paused = false` in the predicate, so a pause that lands while
        // this probe was in flight wins the race. `runMonitorCheck` reads
        // `paused` once, before the probe; without this an operator who
        // pauses a monitor one second before its failure window elapses —
        // precisely to stop the page — still gets paged, and worse, the
        // incident is then unresolvable, because every subsequent check
        // returns early while paused and nothing is left to close it.
        //
        // `paused` alone was not enough, because a pause and a resume
        // both fit inside one 30s probe flight. The row is `paused =
        // false` again by the time this lands, so the write went
        // through and restored the pre-pause `first_failure_at` that
        // the resume had just cleared — the monitor then computed
        // "failing since last week" from its first check back and paged
        // at once, `notified_at` and all. Requiring the value this
        // computation was derived from to still be on the row is what
        // makes the write conditional on the state it assumed.
        .where(
          and(
            eq(monitors.id, monitor.id),
            eq(monitors.paused, false),
            monitor.firstFailureAt === null
              ? isNull(monitors.firstFailureAt)
              : eq(monitors.firstFailureAt, monitor.firstFailureAt),
          ),
        )
        .returning()
    );
  });

  if (!updated) {
    // Several ways to match no row, and they are not the same event.
    const current = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitor.id),
    });
    if (!current) throw new NotFoundError("Monitor disappeared mid-check.");

    // Something moved under the probe — a pause, or a pause and a
    // resume, either way the row is no longer the one this outcome was
    // derived from. The observation stays — it was genuinely made, and
    // a ledger does not un-write facts — but nothing is derived from
    // it: no status change, no incident, no schedule. Returning the
    // current row rather than the stale pre-probe one keeps every
    // caller honest: paused, and the fast-path follow-up declines;
    // resumed, and `next_evaluation_at` is already now, so the monitor
    // measures again immediately instead of losing a cycle.
    return {
      monitor: current,
      reconciliation: {
        status: current.currentStatus,
        openIncident: false,
        resolveIncidents: false,
      },
    };
  }

  return { monitor: updated, reconciliation };
}

/**
 * Slack on the due predicate, and it is load-bearing.
 *
 * The tick runs on the minute, but `next_evaluation_at` is stamped when
 * a probe *completes* — a few seconds past the boundary. Without slack
 * a monitor due at :02:02 is missed by the :02:00 tick and waits for
 * :03:00, every single cycle, so a 120s cadence settles at 180s and a
 * 61s one at 120s. 1.9.x had exactly this constant for exactly this
 * reason; it was dropped when the predicate moved to a stored
 * timestamp, and the drift came straight back.
 *
 * Half a tick period: enough to absorb probe duration, small enough
 * that being early never costs more than half an interval. Anything
 * scheduled sooner than a tick apart is handled by the check job's own
 * follow-up instead.
 */
const TICK_GRACE_SECONDS = 30;

/**
 * "This monitor is owed a probe", written once.
 *
 * Three statements ask it - the selection, the backlog reading and the
 * claim's re-check under the lock - and the third is the one that makes
 * sharing it necessary rather than tidy. A claim whose predicate drifted
 * from the selection's would push forward monitors the selection had
 * never chosen, or refuse ones it had, and either way the symptom would
 * be a cadence that is quietly wrong rather than an error anybody sees.
 *
 * `organizationId` narrows it to one tenant. The worker never passes one
 * - it schedules the whole installation - and the operator surface
 * always does, because in a deployment that holds one organization per
 * client, "18,000 monitors are behind" is another client's number.
 */
function dueCondition(excludedCheckTypes: string[], organizationId?: string) {
  return and(
    organizationId === undefined
      ? undefined
      : eq(monitors.organizationId, organizationId),
    eq(monitors.paused, false),
    excludedCheckTypes.length === 0
      ? undefined
      : notInArray(monitors.checkType, excludedCheckTypes),
    sql`(
      ${monitors.nextEvaluationAt} is null
      or ${monitors.nextEvaluationAt} - make_interval(secs => ${TICK_GRACE_SECONDS}) <= now()
    )`,
    // Nobody else's, right now. The claim is a lease on the RIGHT TO
    // ENQUEUE, held in its own column, so a monitor another tick took a
    // moment ago is invisible here without its due time having moved.
    sql`(
      ${monitors.dispatchClaimedUntil} is null
      or ${monitors.dispatchClaimedUntil} <= now()
    )`,
  );
}

/**
 * "This monitor is LATE", which is a different question from "this
 * monitor is owed a probe".
 *
 * The difference is the claim, and getting it wrong made every
 * measurement of scheduler health useless. A monitor a tick has claimed
 * is not selectable - that is the point of claiming - but it is still
 * late, because nothing has probed it yet. Measuring lateness with the
 * selection predicate therefore made a backlog vanish the instant a tick
 * looked at it, so a fleet the workers could not keep up with reported a
 * lag of at most one lease however far behind it really was.
 *
 * No grace period either. `TICK_GRACE_SECONDS` exists so a monitor due
 * at :02:02 is not missed by the :02:00 tick; it has nothing to do with
 * whether that monitor is late, and subtracting it here would report
 * every fleet as thirty seconds less behind than it is.
 *
 * High-frequency monitors are excluded, and the reason originally given
 * here was false. It said that plane "never writes
 * `next_evaluation_at`", so their due time is frozen and they would
 * report as permanently late. It does write it:
 * `HighFrequencyPlane.promote` calls `applyOutcome`, which is the same
 * `recordCheckOutcome` every other check goes through.
 *
 * The true reason is narrower. `promote` fires only when a sample says
 * something new, so the column advances on that plane's terms rather
 * than on the ordinary cadence, and measuring lateness against it would
 * report a number about a plane this predicate is not measuring.
 *
 * KNOWN GAP, stated rather than hidden: the exclusion is on the FLAG,
 * and the flag is not the same question as "is that plane actually
 * probing this monitor". A tenant whose high-frequency workers are all
 * dead has its monitors scheduled by the ordinary tick, where they can
 * fall arbitrarily behind, and this predicate still reports a backlog
 * of zero for them. Closing it needs the live-lease test, and that
 * lives in JavaScript (`shardOf` is an FNV hash, not a SQL function),
 * so it is a change to how this is computed rather than to the
 * predicate. `modules/monitors/highfreq/stats.ts` answers that plane's
 * own health in the meantime.
 */
function latePredicate(excludedCheckTypes: string[], organizationId?: string) {
  return and(
    organizationId === undefined
      ? undefined
      : eq(monitors.organizationId, organizationId),
    eq(monitors.paused, false),
    eq(monitors.highFrequency, false),
    excludedCheckTypes.length === 0
      ? undefined
      : notInArray(monitors.checkType, excludedCheckTypes),
    sql`${monitors.nextEvaluationAt} <= now()`,
  );
}

/**
 * Monitors the scheduler owes a probe.
 *
 * Note what is not here: any arithmetic on intervals. The predicate is
 * "is it time yet, allowing for tick alignment", and *when* was decided
 * by `nextEvaluationAt` when the last observation landed. That
 * separation is the point — the old `WHERE last_checked_at + interval
 * <= now()` meant the selection query *was* the scheduling policy, so
 * changing the policy meant rewriting the scheduler.
 *
 * Most-overdue first WITHIN a tenant, and then the best-ranked monitor
 * of each tenant first. Plain most-overdue-first across the whole
 * installation is starvation-free for a monitor and starvation BY
 * CONSTRUCTION for a tenant: one organization with five thousand
 * monitors owns the head of the ordering for as long as it is behind,
 * and the tenant next to it with five monitors waits behind all of them
 * however small it is. This is the same shape, and the same fix, as
 * `notification_outbox`'s fair drain - see `dueRankingSql`.
 *
 * The rank is computed in one statement and the rows are fetched by id
 * in a second. Two statements rather than one because the relational
 * query builder cannot express a window function, and a single hand-
 * written statement returning whole rows would have to name and map
 * every column of the widest table in the product.
 *
 * The kind filter is the other half of "a group is never scheduled".
 * A group has nothing to measure and a manual monitor has nothing to
 * ask, so selecting either would spend a queue slot and a worker to
 * write an observation identical to the last one. Stated as "not one of
 * these" rather than "one of the scheduled ones" on purpose: a monitor
 * whose type this build no longer has must keep being evaluated, and
 * keep reporting that it cannot be, instead of quietly falling off the
 * scheduler and looking healthy.
 */
export async function findDueMonitors(
  db: DbClient,
  limit = env.MONITOR_SCHEDULER_BATCH,
  organizationId?: string,
): Promise<Monitor[]> {
  const excluded = [...UNSCHEDULED_CHECK_TYPE_IDS];
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from (
      select
        ${monitors.id} as id,
        ${monitors.nextEvaluationAt} as next_evaluation_at,
        row_number() over (
          partition by ${monitors.organizationId}
          order by ${monitors.nextEvaluationAt} asc nulls first, ${monitors.id}
        ) as rank
      from ${monitors}
      where ${dueCondition(excluded, organizationId)}
    ) ranked
    order by rank, next_evaluation_at asc nulls first, id
    limit ${limit}
  `);
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const found = await db.query.monitors.findMany({
    where: inArray(monitors.id, ids),
  });
  // Returned in the order the ranking chose, not the order the second
  // statement happened to read them in. Nothing downstream depends on
  // it today; a test that asserts fairness does, and an order that is
  // stable only by accident is not evidence of anything.
  const byId = new Map(found.map((monitor) => [monitor.id, monitor]));
  return ids
    .map((id) => byId.get(id))
    .filter((monitor): monitor is Monitor => monitor !== undefined);
}

/**
 * How long a monitor is taken off the due list by being enqueued.
 *
 * THE HOLE THIS EXISTS TO CLOSE. Not a race — `stately` genuinely
 * permits only one ACTIVE job per monitor, so no monitor is ever probed
 * twice at once — but a re-enqueue: the policy allows one queued job
 * beside the active one, so a tick firing while a monitor's check is
 * still running can add another, and the second runs the moment the
 * first finishes.
 *
 * Stated as a hole and not as a bug count, because the two counts this
 * comment used to carry were both wrong. Fifty-nine came from a
 * benchmark whose duplicate threshold was half an interval, which counts
 * the adaptive scheduler legitimately tightening on a monitor that
 * failed; eight replaced it and came from a dirty tree with workers
 * leaked from an earlier run probing the same monitors. Measured on
 * clean trees the figure is zero, in every cell of both builds.
 *
 * Selection was level-triggered on `next_evaluation_at` and enqueueing
 * changed nothing about it, so the tick had no way to know it had
 * already asked. Claiming closes that: the monitor leaves the SELECTABLE
 * set when it is enqueued and comes back when the check lands or the
 * lease runs out.
 *
 * In its own column, not by moving the due time. Moving it worked and
 * was wrong: `next_evaluation_at` stopped meaning "when this is next
 * due", and every reading of how far behind the scheduler is takes its
 * lateness from that column - so claiming a backlog HID it, and a fleet
 * the workers could not keep up with reported a lag of at most one lease
 * forever.
 *
 * The value has to exceed how long a job may sit before it runs, or a
 * busy queue re-enqueues anyway; it has to be finite, or a job that is
 * dropped takes its monitor with it forever.
 *
 * Ninety seconds is the ACTIVE bound plus slack, not the total: pg-boss
 * expires a `monitor-check` after 60 seconds of running and does not
 * retry it, so no single attempt outlives the lease. What can outlive it
 * is queue WAIT on a fleet that is already behind - and there the lease
 * expiring is the correct behaviour rather than a bug, because a monitor
 * whose job has been waiting longer than a lease is one the queue may
 * never get to. The duplicate that produces is bounded by the queue's
 * own unique index, which permits one waiting and one running check per
 * monitor and drops the rest.
 */
export const ENQUEUE_LEASE_SECONDS = 90;

/**
 * Takes the monitors this tick is about to enqueue off the due list.
 *
 * The whole point is what happens when two ticks run at once, which two
 * workers make ordinary rather than exotic. `for update skip locked`
 * means the second tick does not wait for the first and does not see its
 * rows: the two get disjoint sets, and neither has to know the other
 * exists. The `next_evaluation_at` re-check inside the UPDATE is the
 * other half — a monitor whose check completed between the snapshot and
 * the lock is no longer due, and pushing it forward would delay a
 * monitor that had just been probed.
 *
 * Returns the ids actually claimed, which is what the caller enqueues.
 * A caller that enqueued its whole candidate list instead would put back
 * exactly the duplicate this removes.
 */
/**
 * How many ids go into one claim statement.
 *
 * `inArray` binds one parameter per id, and Postgres's wire protocol
 * refuses more than 65,535 in a single Bind message - measured, not
 * assumed: 65,535 succeeds and 70,000 fails with "invalid number of
 * parameter formats". With `MONITOR_SCHEDULER_BATCH` settable to tens of
 * thousands, an operator raising it far enough would have broken every
 * tick in the installation with a protocol error, which is the least
 * debuggable failure this scheduler could produce.
 *
 * A thousand is well under the ceiling and also bounds how many row
 * locks one statement holds at once. Each chunk is independently atomic,
 * so the two-ticks-take-disjoint-sets property is unchanged: `skip
 * locked` decides it per chunk, and a chunk that throws leaves its
 * predecessors claimed - which is the same lease-shaped trade the whole
 * claim makes, at a finer grain.
 */
const CLAIM_CHUNK = 1_000;

export async function claimMonitorsForDispatch(
  db: DbClient,
  monitorIds: readonly string[],
  leaseSeconds = ENQUEUE_LEASE_SECONDS,
): Promise<string[]> {
  if (monitorIds.length === 0) return [];
  if (monitorIds.length > CLAIM_CHUNK) {
    const claimed: string[] = [];
    for (let start = 0; start < monitorIds.length; start += CLAIM_CHUNK) {
      claimed.push(
        ...(await claimMonitorsForDispatch(
          db,
          monitorIds.slice(start, start + CLAIM_CHUNK),
          leaseSeconds,
        )),
      );
    }
    return claimed;
  }
  const { rows } = await db.execute<{ id: string }>(sql`
    with locked as (
      select ${monitors.id} as id
      from ${monitors}
      where ${inArray(monitors.id, [...monitorIds])}
      for update skip locked
    )
    update ${monitors}
       set dispatch_claimed_until = now() + make_interval(secs => ${leaseSeconds})
      from locked
     where ${monitors.id} = locked.id
       and ${dueCondition([...UNSCHEDULED_CHECK_TYPE_IDS])}
    returning ${monitors.id} as id
  `);
  return rows.map((row) => row.id);
}

/**
 * Reserves one monitor's next dispatch, ahead of it being due.
 *
 * The sub-minute path enqueues a check for a monitor whose time has not
 * come yet, so it cannot use the claim above: `dueCondition` asks "is it
 * time", and the honest answer for a monitor due in forty seconds is no.
 * Without a reservation of its own that enqueue is simply outside the
 * scheduler's exclusion - the tick that fires while the follow-up is in
 * flight sees an unclaimed, due monitor and enqueues it a second time.
 *
 * So the predicate here is narrower than due-ness and is only the part
 * that means exclusivity: nobody else holds this monitor right now. One
 * row, one statement - concurrent callers serialise on the row lock the
 * UPDATE takes, and the loser re-evaluates the predicate against the
 * winner's row and matches nothing.
 *
 * Returns whether the reservation was taken. A caller that enqueued
 * regardless would have written this function for nothing.
 */
export async function reserveMonitorForFollowUp(
  db: DbClient,
  monitorId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update ${monitors}
       set dispatch_claimed_until = now() + make_interval(secs => ${leaseSeconds})
     where ${monitors.id} = ${monitorId}
       and ${monitors.paused} = false
       and (
         ${monitors.dispatchClaimedUntil} is null
         or ${monitors.dispatchClaimedUntil} <= now()
       )
    returning ${monitors.id} as id
  `);
  return rows.length > 0;
}

/**
 * Stands the scheduler down from monitors another plane is probing.
 *
 * Enabling high frequency deliberately leaves `next_evaluation_at` where
 * it was, and nothing advances it afterwards - that plane probes on its
 * own timer and never writes the column. So a high-frequency monitor is
 * permanently overdue, and "most overdue first" hands it the head of its
 * tenant's ranking on every tick for as long as the flag is on. The tick
 * then filters it out and throws the slot away. Fifty of them in a tenant
 * is fifty selection slots that can never become work, taken from
 * ordinary monitors that could have used them - starvation produced by
 * the fairness ordering itself.
 *
 * Deferring by one tick period is enough to leave the ranking, and is
 * also the whole failover cost: nothing here reads the flag, only the
 * live lease the caller tested, so a monitor whose plane dies is deferred
 * at most once more and then falls back to the ordinary cadence.
 */
export async function deferHighFrequencyOwned(
  db: DbClient,
  monitorIds: readonly string[],
  seconds: number,
): Promise<void> {
  if (monitorIds.length === 0) return;
  await db
    .update(monitors)
    .set({ nextEvaluationAt: sql`now() + make_interval(secs => ${seconds})` })
    .where(
      and(
        inArray(monitors.id, [...monitorIds]),
        // The caller decided on the LEASE, and it decided a moment ago.
        // This is the flag, re-read under the write, and it is here only
        // to close the gap: an operator who turned high frequency off
        // between the tick's selection and this statement would
        // otherwise have their monitor pushed a minute into the future
        // by a plane that no longer owns it. Failing toward scheduling
        // is the right direction for a monitor nobody is probing.
        eq(monitors.highFrequency, true),
      ),
    );
}

/**
 * How far behind the scheduler is, right now.
 *
 * Two numbers and no history. `dueCount` is the backlog, `oldestDueSeconds`
 * is its age, and the age is the one that matters: a backlog of two
 * hundred that is four seconds old is a healthy tick doing its job, and
 * a backlog of five that is four minutes old is a scheduler that has
 * stopped. A count on its own cannot tell those apart, which is why
 * every dashboard that shows only queue depth eventually surprises
 * somebody.
 *
 * Read by the worker after each tick and by the operator surface. It is
 * deliberately a live query rather than a stored counter: a stored one
 * is wrong the moment the process that maintains it dies, which is
 * exactly when it is being read.
 */
export async function schedulerBacklog(
  db: DbClient,
  organizationId?: string,
): Promise<{
  dueCount: number;
  oldestDueSeconds: number;
}> {
  const excluded = [...UNSCHEDULED_CHECK_TYPE_IDS];
  const { rows } = await db.execute<{
    due_count: number;
    oldest_due_seconds: number;
  }>(sql`
    select
      count(*)::int as due_count,
      -- min(next_evaluation_at), not max(now() - next_evaluation_at).
      -- The two are the same number and not the same query plan: the
      -- partial index is ordered by this column, so the minimum is its
      -- first entry, while an aggregate over an expression has to be
      -- computed row by row. This runs on every tick and every render of
      -- the operator page.
      extract(epoch from (now() - min(${monitors.nextEvaluationAt})))::float
        as oldest_due_seconds
    from ${monitors}
    where ${latePredicate(excluded, organizationId)}
  `);
  return {
    dueCount: rows[0]?.due_count ?? 0,
    // Null when nothing is due, and also when everything due has never
    // been evaluated at all - `min` ignores nulls, exactly as the
    // expression aggregate it replaced did. A never-evaluated monitor has
    // no age to report; it shows up in the count.
    oldestDueSeconds: Math.max(0, rows[0]?.oldest_due_seconds ?? 0),
  };
}

async function findMonitorOrThrow(
  db: DbClient,
  organizationId: string,
  monitorId: string,
): Promise<Monitor> {
  const monitor = await db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.organizationId, organizationId),
    ),
  });
  if (!monitor) throw new NotFoundError("Monitor not found.");
  return monitor;
}
