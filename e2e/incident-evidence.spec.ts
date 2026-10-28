import { expect, test, type Page } from "@playwright/test";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { incidents, member, organization, user } from "@/db/schema";
import type { BurstTransport } from "@/modules/incidents/evidence";
import { applyOutcome } from "@/modules/monitors/outcome";
import { createMonitor } from "@/modules/monitors/service";

/**
 * A controlled failure, all the way to the screen.
 *
 * The integration suite proves the snapshot is stored and proves what is
 * in it. This proves the other half, which no unit test can: that an
 * operator opening the incident in a real browser is shown the thing
 * that was stored, and that it reads as an answer rather than as a dump.
 *
 * The failure is induced through `applyOutcome` - the same function the
 * worker, the probe settle loop and the "check it now" button call - so
 * what is on the screen got there the way a real outage would put it
 * there. Only the four diagnostic sockets are injected, because a test
 * that resolves real hostnames fails on somebody else's DNS.
 */

test.describe.configure({ mode: "serial" });

const runId = Date.now();
const userName = `E2E Evidence ${runId}`;
const userEmail = `e2e-evidence-${runId}@example.com`;
const userPassword = `e2e-pass-${runId}`;
const orgName = `E2E Evidence Org ${runId}`;
const orgSlug = `e2e-evidence-${runId}`;

/** Resolves at the connect: the port is shut. */
const refusing: BurstTransport = {
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  connect: async () => ({ error: "connect ECONNREFUSED 93.184.216.34:443" }),
  handshake: async () => ({ facts: {}, error: null }),
  request: async () => ({ facts: {}, error: null }),
};

test.describe("incident evidence, on the page", () => {
  let page: Page;
  let incidentId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
    // The specs in this file are the only ones that open a database
    // pool in the Playwright process. Left open, the runner has ten idle
    // sockets to wait on before it can exit.
    await db.$client.end();
  });

  test("signs up and creates an organization", async () => {
    await page.goto("/sign-up");
    await page.getByLabel("Name", { exact: true }).fill(userName);
    await page.getByLabel("Work email").fill(userEmail);
    await page.getByLabel("Password").fill(userPassword);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 });

    await page.getByLabel("Organization name").fill(orgName);
    await page.getByLabel("Slug").fill(orgSlug);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  });

  test("induces a failure that opens an incident and captures evidence", async () => {
    const [org] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.slug, orgSlug))
      .limit(1);
    expect(org).toBeDefined();
    const [owner] = await db
      .select({ userId: member.userId })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, org!.id), eq(user.email, userEmail)))
      .limit(1);
    expect(owner).toBeDefined();

    const actor = { organizationId: org!.id, userId: owner!.userId };
    const monitor = await createMonitor(db, actor, {
      name: `Checkout ${runId}`,
      url: "https://checkout.vigil-e2e.example.com/health",
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      checkType: "http",
      tlsCheck: false,
      tlsWarnDays: 14,
      // Zero, so one failing check crosses the window.
      failureWindowSeconds: 0,
    });

    // A healthy check, so the page has a "before" to compare against.
    const healthy = await applyOutcome(monitor, {
      ok: true,
      degraded: false,
      verdict: "up",
      failureClass: null,
      statusCode: 200,
      responseTimeMs: 180,
      error: null,
      facts: { statusCode: 200, responseTimeMs: 180 },
      failedAssertions: [],
    });

    // Then the failure: a bare timeout, which names no layer on its own.
    await applyOutcome(
      healthy,
      {
        ok: false,
        degraded: false,
        verdict: "down",
        failureClass: "transport",
        statusCode: null,
        responseTimeMs: 10_000,
        error: "Timed out after 10000ms",
        facts: { responseTimeMs: 10_000 },
        failedAssertions: [],
      },
      { evidence: { burstEnabled: true, transport: refusing } },
    );

    const [incident] = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.monitorId, monitor.id),
          eq(incidents.source, "monitor"),
        ),
      )
      .limit(1);
    expect(incident).toBeDefined();
    incidentId = incident!.id;
  });

  test("shows the operator what was seen when it opened", async () => {
    await page.goto(`/incidents/${incidentId}`);

    await expect(
      page.getByText("What was seen when this opened").first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    // The layer the diagnostics established, and on whose authority.
    // The observation said only "timed out"; the connect step is what
    // makes "Connection" a measurement rather than a guess. `.first()`
    // because the same label names the stage badge and the step it came
    // from, which is the point rather than a collision.
    await expect(
      page.getByText("Connection", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("measured at onset")).toBeVisible();
    await expect(
      page.getByText(
        /The hostname resolved, but connecting to the port failed/,
      ),
    ).toBeVisible();

    // The observed failure itself.
    await expect(
      page.getByText("Timed out after 10000ms").first(),
    ).toBeVisible();

    // What changed since the last check that worked. The status code
    // stopped being reported at all, which is the informative half of a
    // transport failure and the row an operator acts on.
    await expect(page.getByText("Since the last success")).toBeVisible();
    await expect(page.getByText("no longer reported")).toBeVisible();

    // The diagnostics, with the bound they ran under and the promise
    // that they changed nothing.
    await expect(page.getByText("Onset diagnostics")).toBeVisible();
    await expect(page.getByText(/of a 5000ms budget/)).toBeVisible();
    await expect(page.getByText(/These probes changed nothing/)).toBeVisible();

    // And the honest empty state where there is nothing to relate.
    await expect(page.getByText("Related failures")).toBeVisible();
    await expect(page.getByText(/Time alone is not one/)).toBeVisible();
  });
});
