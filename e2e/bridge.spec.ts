import { createServer, type Server } from "node:http";

import { expect, test, type Page } from "@playwright/test";

/**
 * The Better Stack migration bridge, end to end: connect with a token,
 * import into shadow mode, collect evidence, generate a cutover report,
 * cut over.
 *
 * Better Stack itself is a local stub on a fixed port; the app reaches
 * it because the Playwright web server exports
 * VIGIL_BETTERSTACK_TEST_BASE (see playwright.config.ts), which the
 * bridge honours by rewriting request URLs while every other code path
 * stays exactly as production runs it. Everything else here is real:
 * the session, the permissions, the import engine, the poller, the
 * comparison, the stored report.
 */

// Serial: one browser session walks the whole lifecycle. The timeout is
// generous because the first server action against a dev server compiles
// the bridge's whole module graph on demand, which can take longer than
// the default 30s when the suite has already filled the compiler's day;
// against CI's production build every step here is sub-second.
test.describe.configure({ mode: "serial", timeout: 90_000 });

const runId = Date.now();
const userName = `Bridge User ${runId}`;
const userEmail = `bridge-${runId}@example.com`;
const userPassword = `bridge-pass-${runId}`;
const orgName = `Bridge Org ${runId}`;

const STUB_PORT = 43117;

/** Yesterday, so the stub incident sits inside the first poll window. */
const startedAt = new Date(Date.now() - 20 * 3_600_000).toISOString();
const resolvedAt = new Date(Date.now() - 19 * 3_600_000).toISOString();

function stubBody(path: string, resolvedParam: string | null): unknown {
  if (path === "/v2/monitors") {
    return {
      data: [
        {
          id: "101",
          type: "monitor",
          attributes: {
            url: "https://demo.example.com",
            pronounceable_name: "Demo homepage",
            monitor_type: "status",
            check_frequency: 60,
            request_timeout: 10,
            paused_at: null,
          },
        },
        {
          id: "102",
          type: "monitor",
          attributes: {
            url: "db.example.com",
            pronounceable_name: "Demo database",
            monitor_type: "tcp",
            port: 5432,
            check_frequency: 120,
            request_timeout: 2000,
            paused_at: null,
          },
        },
      ],
      pagination: { next: null },
    };
  }
  if (path === "/v2/monitor-groups" || path === "/v2/heartbeat-groups") {
    return { data: [], pagination: { next: null } };
  }
  if (path === "/v2/heartbeats") {
    return {
      data: [
        {
          id: "7",
          type: "heartbeat",
          attributes: {
            name: "Nightly cron",
            url: "https://uptime.betterstack.com/api/v1/heartbeat/stub-token-never-read",
            period: 86_400,
            grace: 3_600,
            heartbeat_group_id: null,
            paused_at: null,
            status: "up",
          },
        },
      ],
      pagination: { next: null },
    };
  }
  if (path === "/v3/incidents") {
    if (resolvedParam === "false") {
      return { data: [], pagination: { next: null } };
    }
    return {
      data: [
        {
          id: "5001",
          type: "incident",
          attributes: {
            name: "Demo homepage",
            cause: "Status 503",
            status: "Resolved",
            started_at: startedAt,
            resolved_at: resolvedAt,
          },
          relationships: {
            monitor: { data: { id: "101", type: "monitor" } },
          },
        },
      ],
      pagination: { next: null },
    };
  }
  return null;
}

test.describe("Better Stack migration bridge", () => {
  let page: Page;
  let stub: Server;

  test.beforeAll(async ({ browser }) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
      // The one thing the stub enforces: an authenticated read. The app
      // must be sending the operator's token as a bearer, like the real
      // API demands.
      if (req.headers.authorization !== "Bearer e2e-bridge-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: "Unauthorized" }));
        return;
      }
      const body = stubBody(url.pathname, url.searchParams.get("resolved"));
      if (body === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: `no stub for ${url.pathname}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      stub.listen(STUB_PORT, "127.0.0.1", resolve),
    );
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  });

  test.afterAll(async () => {
    await page.close();
    await new Promise<void>((resolve, reject) =>
      stub.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test("signs up and creates an organization", async () => {
    await page.goto("/sign-up");
    await page.getByLabel("Name", { exact: true }).fill(userName);
    await page.getByLabel("Work email").fill(userEmail);
    await page.getByLabel("Password").fill(userPassword);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 });

    await page.getByLabel("Organization name").fill(orgName);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  });

  test("the import page points at the bridge", async () => {
    await page.goto("/settings/import");
    await page.getByRole("link", { name: "migration bridge" }).click();
    await expect(page).toHaveURL(/\/settings\/import\/bridge$/);
    // Card titles are divs, not headings; match the text itself.
    await expect(
      page.getByText("Better Stack migration bridge", { exact: true }),
    ).toBeVisible();
  });

  /**
   * Type the token and prove the page reacted. The input is a
   * controlled component, so a fill that lands before React hydrates
   * writes a value the state never learns about and the submit button
   * stays disabled forever - which is exactly what happened when a slow
   * dev server put hydration behind Playwright's first keystroke. The
   * retry re-fills until the button's enabled state proves the
   * component is live.
   */
  async function fillToken(value: string): Promise<void> {
    await expect(async () => {
      await page.getByLabel("Uptime API token").fill(value);
      await expect(
        page.getByRole("button", { name: /Connect Better Stack|Reconnect/ }),
      ).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
  }

  test("a rejected token stores nothing", async () => {
    await fillToken("wrong-token");
    await page.getByRole("button", { name: "Connect Better Stack" }).click();
    // The stub answers 401; the transport words it for an operator.
    await expect(page.getByText(/token was rejected/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("connected", { exact: true })).toHaveCount(0);
  });

  test("connects with a working token", async () => {
    await fillToken("e2e-bridge-token");
    await page.getByRole("button", { name: "Connect Better Stack" }).click();
    await expect(page.getByText("connected", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("previews, then imports into shadow mode", async () => {
    await page.getByRole("button", { name: "Preview import" }).click();
    // The preview is a real rolled-back run: 2 monitors + 1 heartbeat.
    await expect(page.getByText(/of 3 monitors will be imported/)).toBeVisible({
      timeout: 20_000,
    });

    await page.getByRole("button", { name: "Import into shadow mode" }).click();
    await expect(page.getByText("3 monitor(s) in shadow")).toBeVisible({
      timeout: 20_000,
    });

    // The fleet is visible internally, like any other monitor.
    await page.goto("/monitors");
    // The name is linked twice: the desktop row and the narrow layout
    // both stay in the tree. Either one is the monitor.
    await expect(page.getByText("Demo homepage").first()).toBeVisible();
    await expect(page.getByText("Demo database").first()).toBeVisible();
    await page.goto("/settings/import/bridge");
  });

  test("collects evidence on demand", async () => {
    await page.getByRole("button", { name: "Refresh evidence now" }).click();
    await expect(
      page.getByText(/1 source incident\(s\) on record/),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("generates a frozen cutover report with a conservative verdict", async () => {
    await page.getByRole("button", { name: "Generate cutover report" }).click();
    await expect(page).toHaveURL(/report=/, { timeout: 20_000 });
    const report = page.locator("#report");
    await expect(report).toBeVisible({ timeout: 20_000 });
    await expect(report).toContainText("Cutover report");
    // Minutes-old evidence cannot clear the 24 hour floor, the heartbeat
    // needs repointing, and the source outage predates the import: the
    // only honest verdict is NOT SAFE, with the reasons written out.
    await expect(report.getByText("NOT SAFE", { exact: true })).toBeVisible();
    await expect(report).toContainText(/hours of overlap/);
    await expect(report).toContainText("Manual work before or at cutover");
  });

  test("cuts over: the fleet goes live", async () => {
    await page.getByRole("button", { name: "Cut over" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cut over" }).click();
    await expect(page.getByText("3 monitor(s) are live")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("monitor(s) in shadow")).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
