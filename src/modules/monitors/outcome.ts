import { eq } from "drizzle-orm";

import { db } from "@/db";
import { monitors } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  captureIncidentEvidence,
  type CaptureDeps,
} from "@/modules/incidents/evidence";
import { askAlertHold, askIncidentOpened } from "@/modules/incidents/hooks";
import {
  claimIncidentNotification,
  findUnhandledAutoIncident,
  openMonitorIncident,
  recordSystemEvent,
  resolveMonitorIncidents,
  type Incident,
} from "@/modules/incidents/service";
import { dispatchIntentsNow } from "@/modules/notifications/flush";
import {
  openedIntent,
  recordDispatchIntent,
} from "@/modules/notifications/intents";
import { describeMonitorTarget } from "@/modules/monitors/spec";

import type { CheckResult } from "./check";
import { evaluateMonitor } from "./evaluate";
import { numberFact } from "./types/conditions";
import { dockerIncidentLines } from "./types/docker-restart";
import { recordCheckOutcome, type Monitor } from "./service";
import { checkTypeKind } from "./types/catalog";

/**
 * What happens *because of* an observation: persist it, advance the
 * monitor's state, open or resolve incidents, notify, and re-derive any
 * group that contains this monitor.
 *
 * This lived inside `worker/jobs/monitor-check.ts` until manual
 * monitors arrived and needed every line of it. An operator marking a
 * vendor down must page exactly like a failed probe does — same
 * controller, same failure window, same held-alert handling, same
 * webhook — and the only way to guarantee "exactly like" is for there
 * to be one implementation. Copying forty lines into a server action
 * would have been two implementations from the day it was written, and
 * the copy would be the one that forgets the escalation hook.
 *
 * Never throws for per-monitor problems: the worker's next tick
 * re-enqueues, and a retry here would only double-probe a struggling
 * target.
 */
const log = logger.child({ module: "monitor-outcome" });

interface Enqueuer {
  send: (name: string, data: object, options?: object) => Promise<unknown>;
}

export interface ApplyOutcomeDeps {
  /** The ledger identity this observation is chained under. */
  actorId?: string;
  boss?: Enqueuer;
  now?: Date;
  /**
   * How many groups deep the current propagation already is. Carried on
   * the deps rather than as a parameter so that the bound holds across
   * the whole chain — `applyOutcome` and `refreshGroups` call each
   * other, and a depth that reset at either boundary would bound
   * nothing.
   */
  groupDepth?: number;
  /**
   * Overrides for the incident evidence capture: the sockets its
   * diagnostic burst uses, and whether it may run at all.
   *
   * Injectable for the reason `fetchImpl` and `lookup` are on the check
   * path — a test that proves the snapshot must not need a network, and
   * a suite that quietly resolves real hostnames fails in a different
   * test every run. Unset in production, which selects the real sockets
   * and the installation's own setting.
   */
  evidence?: CaptureDeps;
}

/**
 * How deep a chain of nested groups is followed.
 *
 * A cycle cannot be created through the service layer — `assertParent`
 * refuses one — but this loop runs on the worker's hot path against
 * whatever is in the database, including rows written by a future
 * version or restored from a backup taken mid-edit. A bound turns a
 * cycle into a truncated propagation instead of a wedged worker.
 */
const MAX_GROUP_DEPTH = 8;

/**
 * Renders a hold deadline for the incident timeline. Operators read this
 * line while an outage is open, so the deadline is stated in the entry
 * rather than left implicit in whatever scheduled it — a hold with no
 * visible expiry is indistinguishable from silence.
 */
function describeDelay(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/**
 * Claims the right to page for a newly opened incident and, in the same
 * transaction, records what that page owes: both channel events, the
 * status-page audience and the responder email.
 *
 * The claim and the consequences are one commit. They used to be two,
 * and the order made the failure permanent: `notified_at` was spent
 * first, then the notifications were assembled in a second transaction
 * that could die — and once the claim is spent, `findUnhandledAutoIncident`
 * can no longer see the incident, so nothing repairs it. An outage went
 * completely unannounced with every marker saying it had been handled.
 *
 * Returns the claimed incident, or null if somebody else claimed it
 * first — the open path, recovery exhaustion and the escalation failsafe
 * all race here and exactly one wins.
 *
 * `pagedElsewhere` is how an edition takes over reaching a person — an
 * on-call ladder scheduled by an incident handler pages on its own
 * timetable, and the responder email must not also go out. Default false
 * is the safe direction: when in doubt, someone is emailed.
 */
export async function claimOpenedNotifications(
  incident: Incident,
  monitor: Monitor,
  pagedElsewhere = false,
): Promise<Incident | null> {
  const claimed = await claimIncidentNotification(
    db,
    incident.id,
    async (tx, row) => {
      await recordDispatchIntent(tx, {
        organizationId: monitor.organizationId,
        causeKey: `incident:${row.id}:incident.opened`,
        kind: "incident",
        incidentId: row.id,
        payload: openedIntent({
          incident: row,
          monitor: {
            id: monitor.id,
            name: monitor.name,
            url: monitor.url,
            currentStatus: monitor.currentStatus,
            checkType: monitor.checkType,
            failureWindowSeconds: monitor.failureWindowSeconds,
          },
          monitorTarget: describeMonitorTarget(monitor),
          ...(pagedElsewhere ? { pagedElsewhere } : {}),
        }),
      });
    },
  );
  // Best-effort freshness only. Everything owed is already committed, so
  // if this dies with the process the worker's next tick expands it.
  if (claimed) await dispatchIntentsNow(db, monitor.organizationId);
  return claimed;
}

/**
 * Stores what was known when this incident opened.
 *
 * A wrapper for one reason: the two call sites below (shadow and loud)
 * must pass the same arguments, and the failure mode of letting them
 * diverge is a shadow incident that dials a target because somebody
 * added a parameter to one of them.
 */
async function captureEvidence(
  incident: Incident,
  monitor: Monitor,
  outcome: CheckResult,
  deps: ApplyOutcomeDeps,
): Promise<void> {
  await captureIncidentEvidence(
    db,
    {
      organizationId: monitor.organizationId,
      incidentId: incident.id,
      monitor,
      outcome,
      // The incident's own stored flag, never the monitor's current
      // setting, for the same reason every other suppression here reads
      // it: a cutover landing mid-check must not turn a shadow incident
      // into one that dials.
      shadow: incident.shadow,
    },
    { ...(deps.now ? { now: deps.now } : {}), ...deps.evidence },
  );
}

export async function applyOutcome(
  monitor: Monitor,
  outcome: CheckResult,
  deps: ApplyOutcomeDeps = {},
): Promise<Monitor> {
  const { monitor: updated, reconciliation } = await recordCheckOutcome(
    db,
    monitor,
    outcome,
    { actorId: deps.actorId, now: deps.now },
  );

  log.debug(
    {
      monitorId: monitor.id,
      verdict: outcome.verdict,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      status: updated.currentStatus,
    },
    "observation recorded",
  );

  /**
   * The incident whose evidence is owed, captured at the very end.
   *
   * Deferred rather than captured where it is decided, because the
   * diagnostic burst can take seconds and everything below the incident
   * block is on the check's critical path: the state-change runbook
   * trigger, the group re-derivation, and - through the caller - the
   * sub-minute follow-up. The high-frequency plane is the sharpest case:
   * it holds a per-monitor `promoting` flag across this whole call and
   * promotes nothing else while it is set, so a burst in the middle
   * would stall a plane whose entire purpose is a sub-second cadence.
   */
  let pendingEvidence: Incident | null = null;

  // Level-triggered: act on what is true now, not on what just changed.
  // `openMonitorIncident` returns null when one is already open and
  // `resolveMonitorIncidents` returns nothing when there is none, so
  // running these every check converges rather than duplicating — and a
  // monitor that somehow ended up down with no incident repairs itself
  // instead of staying wrong until someone notices.
  if (reconciliation.openIncident) {
    const created = await openMonitorIncident(
      db,
      updated,
      outcome.error ?? "check failed",
    );
    if (created) {
      for (const line of dockerIncidentLines(outcome)) {
        await recordSystemEvent(db, created.id, line);
      }
    }
    // Level-triggered on "this incident has not been acted on", not on
    // "I am the transaction that inserted it".
    //
    // `openMonitorIncident` returns null once the row exists, so hanging
    // the block below off it made the page, the recovery job and the
    // escalation ladder consequences of ONE transaction succeeding
    // end-to-end. A worker that committed the insert and then died left
    // an incident open with nobody notified, every later check took the
    // null path, and nobody was ever paged - in a product whose entire
    // job is paging people. Re-reading on the null path is what makes
    // the comment above this block true.
    const incident =
      created ?? (await findUnhandledAutoIncident(db, updated.id));
    if (incident) {
      log.warn(
        { monitorId: monitor.id, incidentId: incident.id },
        "incident opened",
      );

      // A shadow incident is recorded and then deliberately left alone:
      // no page, no hooks, no recovery, no ladder, no runbook. The
      // decision reads the incident's own stored flag rather than the
      // monitor's current setting, so a cutover that lands between this
      // check's observation and this line cannot turn a shadow
      // incident loud halfway through its handling - the incidents a
      // cutover owes a page to are re-opened by the next check, live.
      //
      // The system event is load-bearing, not decoration: it is the
      // marker `findUnhandledAutoIncident` refuses, which is what stops
      // every later check from re-entering this block to re-decide an
      // incident that was already decided. The maintenance hold works
      // the same way, and a worker that dies between the insert and
      // this event is repaired by the next check taking this branch
      // again.
      if (incident.shadow) {
        await recordSystemEvent(
          db,
          incident.id,
          "Opened in shadow mode: this monitor runs beside the system it " +
            "was migrated from, so the incident was recorded for " +
            "comparison and nobody was paged. It appears on no status " +
            "page and triggers no automation.",
        );
        log.info(
          { monitorId: monitor.id, incidentId: incident.id },
          "shadow incident recorded without paging",
        );
        // Recorded, like the incident itself, and with the burst
        // refused. A shadow fleet exists to be compared, so the
        // evidence for a comparison is worth keeping; what it must not
        // do is put four more requests on somebody's endpoint during a
        // migration, when the same target is already being watched
        // twice. `captureBurst` writes `skipped: "shadow"` so the page
        // says which of the two happened.
        await refreshGroups(updated.parentId, deps);
        await captureEvidence(incident, updated, outcome, deps);
        return updated;
      }

      const ctx = { db, incident, monitor: updated, boss: deps.boss };

      // Two questions, and this file asks nothing else. With no handler
      // registered — the free edition — the answers are "no hold" and
      // "nothing scheduled", and the incident pages exactly as it would
      // have before any of this existed.
      const held = await askAlertHold(ctx);
      const scheduled = await askIncidentOpened({ ...ctx, held });

      if (held) {
        // The system event is also the marker that a handler has
        // decided about this incident: `findUnhandledAutoIncident`
        // refuses a row that has one, so a held incident is handled
        // once and not re-handled on every subsequent check.
        await recordSystemEvent(
          db,
          incident.id,
          `${held.reason} Operators will be alerted no later than ` +
            `${describeDelay(held.deadlineSeconds)} from now.`,
        );
      } else {
        // The claim decides who sends, and it is the database that
        // decides. Two workers reaching here for one incident - the one
        // that opened it and one repairing after a crash - both attempt
        // it, and only the one whose UPDATE matched `notified_at is
        // null` pages. The claim and what it owes now commit together,
        // so losing the race and losing the process have the same
        // outcome: nothing half-done.
        await claimOpenedNotifications(
          incident,
          updated,
          scheduled.pagesAHuman,
        );
      }

      log.info(
        {
          monitorId: monitor.id,
          incidentId: incident.id,
          held: Boolean(held),
          pagesAHuman: scheduled.pagesAHuman,
        },
        "incident handlers answered",
      );

      // Noted here and captured at the very end of this function. It
      // must not sit in front of the page above it, and it must not sit
      // in front of the state-change trigger, the group refresh or the
      // caller's follow-up scheduling below it - so it goes last, past
      // everything, rather than merely last inside this block.
      pendingEvidence = incident;
    }
  } else if (reconciliation.resolveIncidents) {
    // The all-clear is written inside `resolveMonitorIncidents`, in the
    // transaction that closes the incident — this loop used to send it
    // afterwards in four more transactions, and a crash between them
    // lost it with nothing able to notice. All that is left out here is
    // the log line and a nudge to expand promptly.
    const resolved = await resolveMonitorIncidents(db, updated);
    for (const incident of resolved) {
      log.info(
        { monitorId: monitor.id, incidentId: incident.id },
        "incident auto-resolved",
      );
    }
    if (resolved.length > 0) {
      await dispatchIntentsNow(db, updated.organizationId);
    }
  }


  await refreshGroups(updated.parentId, deps);

  // Genuinely last. Nothing in this function, and nothing the caller
  // does with the row it gets back, is waiting on it: the page has gone
  // out, automation has been told, the groups have been re-derived. A
  // worker that dies here loses a diagnostic row and nothing else.
  if (pendingEvidence) {
    await captureEvidence(pendingEvidence, updated, outcome, deps);
  }
  return updated;
}

/**
 * Re-derives the group a monitor belongs to, and its group, and so on.
 *
 * This is what makes an aggregate monitor work without ever being
 * scheduled: a group has nothing of its own to measure, so the only
 * moment its state can have changed is the moment one of its members'
 * did. Propagating from the member is therefore both sufficient and
 * cheaper than polling — a group of forty monitors costs one derivation
 * per member observation instead of forty reads per tick forever.
 */
export async function refreshGroups(
  groupId: string | null,
  deps: ApplyOutcomeDeps,
): Promise<void> {
  if (groupId === null) return;
  const depth = deps.groupDepth ?? 0;
  if (depth >= MAX_GROUP_DEPTH) {
    log.error({ groupId, depth }, "group nesting too deep; stopping");
    return;
  }
  const deeper: ApplyOutcomeDeps = { ...deps, groupDepth: depth + 1 };

  const group = await db.query.monitors.findFirst({
    where: eq(monitors.id, groupId),
  });
  if (!group || group.paused) return;
  if (checkTypeKind(group.checkType) !== "aggregate") return;

  const now = deps.now ?? new Date();
  const outcome = await evaluateMonitor(db, group, { now });

  const intervalSeconds = await syncGroupCadence(group, outcome);

  if (!shouldRecord(group, outcome, intervalSeconds, now)) {
    // Nothing changed and the last recording still stands. Skipping the
    // write is what stops a group of forty monitors turning forty
    // observations a minute into eighty; the recording rule itself is
    // what stops that saving from becoming a coverage gap. The chain
    // above still has to be walked — a group whose own throttle has
    // elapsed is owed a recording even when this one's has not.
    await refreshGroups(group.parentId, deeper);
    return;
  }

  // `applyOutcome` walks on up from here, which is why this does not.
  await applyOutcome(group, outcome, { ...deeper, now });
}

/**
 * Keeps a group's interval equal to its slowest member's.
 *
 * A group has no cadence of its own: it can only learn something when a
 * member reports. Stored rather than derived at read time because
 * `uptime.ts` sizes an observation's coverage horizon from
 * `interval_seconds` in SQL — so a group left on the 60-second default
 * while its members report hourly would show its evidence expiring
 * every three minutes and report gaps in coverage that were never gaps
 * in evidence.
 */
async function syncGroupCadence(
  group: Monitor,
  outcome: CheckResult,
): Promise<number> {
  const memberInterval = numberFact(outcome.facts, "memberIntervalSeconds");
  if (memberInterval === null || memberInterval === group.intervalSeconds) {
    return group.intervalSeconds;
  }
  await db
    .update(monitors)
    .set({ intervalSeconds: memberInterval })
    .where(eq(monitors.id, group.id));
  // Returned rather than left for the caller to re-read: the throttle
  // below is measured against this interval, and using the row's stale
  // copy would judge the first derivation after a membership change by
  // the cadence the group no longer has.
  return memberInterval;
}

/**
 * Whether this derivation is worth an observation row.
 *
 * Two rules, and the second is the one that keeps uptime honest. A
 * changed state is always recorded — that is the evidence an operator
 * came looking for. An unchanged state is recorded once per interval,
 * which is precisely the cadence `coverageHorizonMs` expects: record
 * less often and a steady group reports uncovered time it had evidence
 * for; record on every member observation and a group of forty doubles
 * the largest table in the product to say "still fine" forty times.
 */
function shouldRecord(
  group: Monitor,
  outcome: CheckResult,
  intervalSeconds: number,
  now: Date,
): boolean {
  if (group.lastCheckedAt === null) return true;
  if (statusOf(outcome) !== group.currentStatus) return true;
  const elapsedMs = now.getTime() - group.lastCheckedAt.getTime();
  return elapsedMs >= intervalSeconds * 1000;
}

/** The status this verdict would establish, ignoring failure windows. */
function statusOf(outcome: CheckResult): Monitor["currentStatus"] {
  switch (outcome.verdict) {
    case "up":
      return "up";
    case "degraded":
      return "degraded";
    case "down":
      return "down";
    case "indeterminate":
      return "unknown";
  }
}

/**
 * Records what a monitor whose state is declared rather than measured
 * currently says, and applies the consequences.
 *
 * Called after a create or an edit — the two moments a manual
 * monitor's status can change, and the moment a group's membership can.
 * An active or passive monitor has nothing to declare and is left for
 * the scheduler.
 */
export async function refreshDeclaredState(
  monitor: Monitor,
  deps: ApplyOutcomeDeps = {},
): Promise<void> {
  const kind = checkTypeKind(monitor.checkType);
  if (kind === "manual" || kind === "aggregate") {
    const outcome = await evaluateMonitor(db, monitor, { now: deps.now });
    await applyOutcome(monitor, outcome, deps);
    return;
  }
  // Not declared, but its membership may have changed: a monitor
  // joining or leaving a group changes that group's state even though
  // nothing about the monitor itself was observed.
  await refreshGroups(monitor.parentId, deps);
}
