import { and, asc, eq, sql } from "drizzle-orm";

import type { DbClient } from "@/db";
import { monitors } from "@/db/schema";

import { judgeMeasurement, performCheck, type CheckOptions } from "./check";
import { readDockerCheckState } from "./types/docker-restart";
import type { CheckResult } from "./check";
import { lastHeartbeat } from "./heartbeat";
import type { Monitor } from "./service";
import { toCheckSpec } from "./spec";
import {
  isActiveType,
  isAggregateType,
  isManualType,
  isPassiveType,
} from "./types/contract";
import type { ChildState } from "./types/contract";
import { findCheckType } from "./types/registry";

/**
 * One monitor, one observation — whatever kind it is.
 *
 * Four ways of coming to know something, one shape of answer. The
 * caller does not learn which happened: it gets a {@link CheckResult}
 * exactly like the one a probe produces, judged by the same engine
 * against the same declared assertions, and everything downstream —
 * the status controller, incidents, uptime, the ledger — carries on
 * unable to tell a dialled monitor from a derived one.
 *
 * That indistinguishability is the deliverable. The alternative, and
 * the shape this replaced in every product that has grown a group type
 * late, is a second pipeline: groups with their own status field, their
 * own incident rules and their own uptime that quietly means something
 * else. Two pipelines is how a status page ends up green because the
 * group's copy of the state was never updated.
 */
export interface EvaluationOptions extends CheckOptions {
  now?: Date;
}

export async function evaluateMonitor(
  db: DbClient,
  monitor: Monitor,
  options: EvaluationOptions = {},
): Promise<CheckResult> {
  const now = options.now ?? new Date();
  const definition = findCheckType(monitor.checkType);

  // Unknown to this build: `performCheck` owns that answer, and gives
  // the same "not available in this build" indeterminate it always has.
  if (definition === undefined || isActiveType(definition)) {
    return performCheck(toCheckSpec(monitor), {
      ...options,
      ...(monitor.checkType === "docker"
        ? {
            dockerMemory: {
              now,
              previous: readDockerCheckState(monitor.dockerState),
            },
          }
        : {}),
    });
  }

  if (isPassiveType(definition)) {
    const config = definition.fromRow(monitor);
    const heartbeat = await lastHeartbeat(db, monitor.id);
    return judgeMeasurement(
      definition.assertions,
      config,
      definition.observe({
        config,
        lastHeartbeatAt: heartbeat?.receivedAt ?? null,
        reported: heartbeat?.report ?? null,
        // Creation is where the clock starts before the first beat.
        // Without it a monitor made ten seconds ago has been silent
        // since the epoch and every push monitor is born down.
        since: monitor.createdAt,
        now,
      }),
    );
  }

  if (isAggregateType(definition)) {
    const config = definition.fromRow(monitor);
    return judgeMeasurement(
      definition.assertions,
      config,
      definition.derive({
        config,
        children: await memberStates(db, monitor.id, monitor.shadowBridgeId),
      }),
    );
  }

  if (isManualType(definition)) {
    const config = definition.fromRow(monitor);
    return judgeMeasurement(
      definition.assertions,
      config,
      definition.declare({ config }),
    );
  }

  // Unreachable while the union is exhausted, and deliberately not an
  // exception: a kind this function has not learned about yet must not
  // be able to take a worker down.
  return {
    ok: false,
    degraded: false,
    statusCode: null,
    responseTimeMs: null,
    error: `Vigil does not know how to evaluate a "${monitor.checkType}" monitor.`,
    verdict: "indeterminate",
    failureClass: "misconfigured",
    facts: {},
    failedAssertions: [],
  };
}

/**
 * A group's members, ordered so the "worst member" fact is stable
 * across evaluations that find the same states.
 *
 * A member is only a member if it shares the group's shadow setting.
 * `IS NOT DISTINCT FROM` because both sides are usually null: a live
 * group aggregates live members, and a group imported by a migration
 * bridge aggregates the members that came with it. What the predicate
 * refuses is the mix - a shadow monitor filed into a live group must
 * not be able to turn that group red and page for a fleet that exists
 * to be watched without consequences, and a live monitor moved under a
 * shadow group must not have its state swallowed by a group nothing is
 * allowed to announce.
 */
export async function memberStates(
  db: DbClient,
  groupId: string,
  groupShadowBridgeId: string | null,
): Promise<ChildState[]> {
  const rows = await db
    .select({
      id: monitors.id,
      name: monitors.name,
      status: monitors.currentStatus,
      paused: monitors.paused,
      intervalSeconds: monitors.intervalSeconds,
    })
    .from(monitors)
    .where(
      and(
        eq(monitors.parentId, groupId),
        sql`${monitors.shadowBridgeId} is not distinct from ${groupShadowBridgeId}`,
      ),
    )
    .orderBy(asc(monitors.createdAt));
  return rows;
}
