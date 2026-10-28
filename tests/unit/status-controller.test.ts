import { describe, expect, it } from "vitest";

import {
  advanceFailureRun,
  deriveStatus,
  reconcile,
  type MonitorStatus,
  type ObservedState,
} from "@/modules/monitors/status-controller";

const NOW = new Date("2026-07-26T12:00:00Z");
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const spec = { failureWindowSeconds: 60 };

function observed(
  overrides: Partial<ObservedState> & Pick<ObservedState, "verdict">,
): ObservedState {
  return {
    firstFailureAt: null,
    previousStatus: "up" as MonitorStatus,
    now: NOW,
    ...overrides,
  };
}

describe("deriveStatus", () => {
  it("maps a passing verdict to up", () => {
    expect(deriveStatus(spec, observed({ verdict: "up" }))).toBe("up");
  });

  it("maps a degraded verdict to degraded", () => {
    expect(deriveStatus(spec, observed({ verdict: "degraded" }))).toBe(
      "degraded",
    );
  });

  it("maps indeterminate to unknown, never down", () => {
    expect(
      deriveStatus(
        spec,
        observed({
          verdict: "indeterminate",
          firstFailureAt: NOW,
          now: at(9999),
        }),
      ),
    ).toBe("unknown");
  });

  it("goes down exactly at the window boundary", () => {
    expect(
      deriveStatus(
        spec,
        observed({ verdict: "down", firstFailureAt: NOW, now: at(60) }),
      ),
    ).toBe("down");
  });

  it("goes down immediately when the window is zero", () => {
    expect(
      deriveStatus(
        { failureWindowSeconds: 0 },
        observed({ verdict: "down", firstFailureAt: NOW }),
      ),
    ).toBe("down");
  });

  it("is a function of elapsed time, not of how many checks ran", () => {
    // One failing observation and a long gap — a missed tick, a
    // restarted worker, a backfill. An edge-triggered controller would
    // still be counting; this one already knows.
    expect(
      deriveStatus(
        spec,
        observed({ verdict: "down", firstFailureAt: NOW, now: at(3600) }),
      ),
    ).toBe("down");
  });

  describe("failing, but inside the window", () => {
    // The status here is not "healthy" — it is "the last thing actually
    // established, not yet contradicted". Reporting `up` unconditionally
    // publishes green Operational for a service that is failing.
    it("keeps a healthy monitor up until the window elapses", () => {
      expect(
        deriveStatus(
          spec,
          observed({
            verdict: "down",
            firstFailureAt: NOW,
            previousStatus: "up",
            now: at(59),
          }),
        ),
      ).toBe("up");
    });

    it("does not turn a monitor that has never succeeded green", () => {
      expect(
        deriveStatus(
          spec,
          observed({
            verdict: "down",
            firstFailureAt: NOW,
            previousStatus: "unknown",
            now: at(30),
          }),
        ),
      ).toBe("unknown");
    });

    it("does not erase an existing degraded state", () => {
      expect(
        deriveStatus(
          spec,
          observed({
            verdict: "down",
            firstFailureAt: NOW,
            previousStatus: "degraded",
            now: at(30),
          }),
        ),
      ).toBe("degraded");
    });

    it("keeps an already-down monitor down when the window is widened", () => {
      // Widening mid-outage: elapsed is now inside the new window, but
      // nothing recovered, so nothing goes green.
      expect(
        deriveStatus(
          { failureWindowSeconds: 3600 },
          observed({
            verdict: "down",
            firstFailureAt: NOW,
            previousStatus: "down",
            now: at(600),
          }),
        ),
      ).toBe("down");
    });
  });

  it("is idempotent — same state in, same status out, any number of times", () => {
    const state = observed({
      verdict: "down",
      firstFailureAt: NOW,
      now: at(120),
    });
    expect(deriveStatus(spec, state)).toBe(deriveStatus(spec, state));
  });
});

describe("advanceFailureRun", () => {
  it("starts a run on the first failure", () => {
    expect(advanceFailureRun(null, "down", NOW)).toBe(NOW);
  });

  it("keeps the original start on subsequent failures", () => {
    expect(advanceFailureRun(NOW, "down", at(500))).toBe(NOW);
  });

  it("clears the run on a pass", () => {
    expect(advanceFailureRun(NOW, "up", at(10))).toBeNull();
    expect(advanceFailureRun(NOW, "degraded", at(10))).toBeNull();
  });

  it("leaves the run untouched when the probe could not run", () => {
    expect(advanceFailureRun(NOW, "indeterminate", at(10))).toBe(NOW);
    expect(advanceFailureRun(null, "indeterminate", at(10))).toBeNull();
  });
});

describe("reconcile", () => {
  it("asks to open an incident once the monitor is down", () => {
    expect(
      reconcile(
        spec,
        observed({ verdict: "down", firstFailureAt: NOW, now: at(60) }),
      ),
    ).toEqual({ status: "down", openIncident: true, resolveIncidents: false });
  });

  it("asks to resolve when a probe observed the target healthy", () => {
    expect(reconcile(spec, observed({ verdict: "up" }))).toMatchObject({
      openIncident: false,
      resolveIncidents: true,
    });
    expect(reconcile(spec, observed({ verdict: "degraded" }))).toMatchObject({
      openIncident: false,
      resolveIncidents: true,
    });
  });

  it("does not let a degraded sample close an incident these causes are holding", () => {
    expect(
      reconcile(
        spec,
        observed({ verdict: "degraded", degradedResolves: false }),
      ),
    ).toMatchObject({
      status: "degraded",
      openIncident: false,
      resolveIncidents: false,
    });
  });

  it("never resolves on a failing verdict, whatever the derived status", () => {
    // The regression this guards: resolve used to key off the derived
    // status, so "failing but inside the window" read as recovery and
    // terminally closed a live incident.
    const inWindow = reconcile(
      spec,
      observed({
        verdict: "down",
        firstFailureAt: NOW,
        previousStatus: "up",
        now: at(30),
      }),
    );
    expect(inWindow.status).toBe("up");
    expect(inWindow.resolveIncidents).toBe(false);
  });

  it("never resolves when a widened window puts a live outage back in range", () => {
    const widened = reconcile(
      { failureWindowSeconds: 3600 },
      observed({
        verdict: "down",
        firstFailureAt: NOW,
        previousStatus: "down",
        now: at(600),
      }),
    );
    expect(widened.resolveIncidents).toBe(false);
  });

  it("asks for nothing at all when it does not know", () => {
    // Resolving here would announce a recovery nobody observed.
    expect(
      reconcile(
        spec,
        observed({
          verdict: "indeterminate",
          firstFailureAt: NOW,
          now: at(600),
        }),
      ),
    ).toEqual({
      status: "unknown",
      openIncident: false,
      resolveIncidents: false,
    });
  });

  it("keeps asking to open while still down — the caller must be idempotent", () => {
    // This is the level-triggered contract. Running it repeatedly is
    // safe and expected; convergence is the caller's job, not a flag's.
    const state = observed({
      verdict: "down",
      firstFailureAt: NOW,
      now: at(300),
    });
    expect(reconcile(spec, state).openIncident).toBe(true);
    expect(reconcile(spec, state).openIncident).toBe(true);
  });
});
