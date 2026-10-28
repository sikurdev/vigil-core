import type { Verdict } from "./types/conditions";

/**
 * The status controller.
 *
 * Level-triggered, never edge-triggered. Until 1.10.0 the check path
 * computed `becameDown` / `becameUp` transition booleans and every
 * consequence hung off those edges. That works only if you observe
 * every transition — and with backfill, replay, a restarted worker, a
 * missed tick or (later) an edge node reconnecting with three days of
 * observations, you will not. An edge-triggered system fails *silently*
 * when it misses one, which is the only failure a monitoring product
 * may not have.
 *
 * So: no transitions. `deriveStatus` asks "what is true now", and
 * `reconcile` asks "what should be true, and what do I do about the
 * difference". Both are pure and both are safe to run repeatedly, at
 * any time, having missed anything.
 */

export type MonitorStatus = "up" | "down" | "degraded" | "unknown";

export interface StatusSpec {
  /** How long the monitor must be failing before it is called down. */
  failureWindowSeconds: number;
}

export interface ObservedState {
  /** The most recent judged verdict. */
  verdict: Verdict;
  /** When the current run of failures began; null when not failing. */
  firstFailureAt: Date | null;
  /**
   * The status currently stored on the monitor.
   *
   * Read, not remembered: it is a column, so this stays a pure function
   * of stored state and running it twice still gives the same answer.
   * It exists because "failing, but the window has not elapsed" is not a
   * status of its own — it is "whatever we last knew, not yet
   * contradicted".
   */
  previousStatus: MonitorStatus;
  now: Date;
  /**
   * Whether a degraded sample may close an open incident.
   *
   * True for every check that has always worked this way. False when
   * the open incident was opened by a Docker restart loop or by an
   * unhealthy healthcheck that this monitor counts as down: a later
   * amber sample is not evidence that either of those recovered.
   */
  degradedResolves?: boolean;
}

export function deriveStatus(
  spec: StatusSpec,
  observed: ObservedState,
): MonitorStatus {
  switch (observed.verdict) {
    case "up":
      return "up";
    case "degraded":
      return "degraded";
    case "indeterminate":
      // The probe could not run. Vigil does not know, and "unknown" is
      // the only honest answer — reporting `down` would make an
      // operator error indistinguishable from an outage.
      return "unknown";
    case "down": {
      const failingForMs =
        observed.firstFailureAt === null
          ? 0
          : observed.now.getTime() - observed.firstFailureAt.getTime();
      if (failingForMs >= spec.failureWindowSeconds * 1000) return "down";

      // Failing, but the operator's window has not elapsed: not yet an
      // outage — and not a clean bill of health either. Returning "up"
      // here (as 1.10.0 briefly did) publishes green "Operational" on a
      // public status page for a service that is failing right now, and
      // erases a `degraded` a monitor was already sitting in.
      //
      // The honest answer is the last thing actually established. A
      // monitor that has never succeeded stays `unknown`; one that was
      // up stays up until the window says otherwise; one that was
      // already down stays down. That is what the threshold always
      // meant, and it is what 1.9.x did before the status became
      // derived.
      return observed.previousStatus;
    }
  }
}

/**
 * When the current failure run started, given the previous value and
 * the verdict just observed.
 *
 * `indeterminate` deliberately leaves the run untouched: a probe that
 * could not run neither starts a failure nor clears one.
 */
export function advanceFailureRun(
  previous: Date | null,
  verdict: Verdict,
  now: Date,
): Date | null {
  if (verdict === "down") return previous ?? now;
  if (verdict === "indeterminate") return previous;
  return null;
}

export interface Reconciliation {
  status: MonitorStatus;
  /** Open an incident if one is not already open. */
  openIncident: boolean;
  /** Resolve any open incident for this monitor. */
  resolveIncidents: boolean;
}

/**
 * The whole controller: given the spec and what was observed, what
 * should be true.
 *
 * Note what is absent — any notion of "it just changed". Running this
 * on every check rather than only on transitions costs one indexed
 * query and buys the property that a monitor which somehow ended up
 * down with no incident, or up with a stale open one, repairs itself on
 * the next check instead of staying wrong forever.
 */
export function reconcile(
  spec: StatusSpec,
  observed: ObservedState,
): Reconciliation {
  const status = deriveStatus(spec, observed);
  return {
    status,
    openIncident: status === "down",
    // Gated on the verdict, not on the derived status. Deriving it from
    // the status meant any path that produced "up" counted as proof of
    // recovery — including "failing, but inside the window", so widening
    // `failureWindowSeconds` during a live outage terminally resolved
    // the incident and emailed subscribers a recovery that never
    // happened. An incident closes when a probe observed the target
    // healthy, and on nothing else.
    //
    // Never on `indeterminate` either: closing because the probe stopped
    // working would report a recovery nobody observed.
    resolveIncidents:
      observed.verdict === "up" ||
      (observed.verdict === "degraded" && observed.degradedResolves !== false),
  };
}
