import "dotenv/config";

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq, ne } from "drizzle-orm";

import { chromium, type Locator, type Page } from "@playwright/test";

import { db } from "@/db";
import {
  incidents,
  monitors,
  organization,
} from "@/db/schema";
import { DEMO_ORG, DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";

/**
 * Every application screenshot the README, the docs and the landing page
 * publish, captured from a running build seeded with the demo data.
 *
 *   npm run db:seed && npm run demo:agency && npm run demo:probes-seed
 *   npm run screenshots        # against a production build on :3000
 *
 * Writes `docs/screenshots/app.manifest.json` beside the files, in the
 * same shape as `probes.manifest.json`: sha256, byte size, viewport and
 * the commit the capture ran at. `npm run shots:check` reads both back.
 *
 * The remote-probe captures (fleet, policy editor, the four quorum
 * outcomes) are NOT here: they need real agents and a controlled
 * partition, which is `scripts/capture-probe-screenshots.ts` against
 * `./scripts/probe-demo.sh up`.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
const MANIFEST = join(OUT, "app.manifest.json");
const VIEWPORT = { width: 1440, height: 900 };

interface Shot {
  file: string;
  scenario: string;
  command: string | null;
  shows: string;
  viewport: string;
  bytes: number;
  sha256: string;
}

const shots: Shot[] = [];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function headCommit(): string {
  // The gate's exported tree is not a git repository, so a capture run
  // inside it names its source commit explicitly.
  if (process.env.VIGIL_SOURCE_COMMIT) return process.env.VIGIL_SOURCE_COMMIT;
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

async function capture(
  target: Locator | Page,
  file: string,
  shows: string,
): Promise<void> {
  const path = join(OUT, file);
  await target.screenshot({ path });
  shots.push({
    file,
    scenario: file.replace(/\.png$/, ""),
    command: null,
    shows,
    viewport: `${VIEWPORT.width}x${VIEWPORT.height}@2x`,
    bytes: readFileSync(path).byteLength,
    sha256: sha256(path),
  });
  console.log(`captured ${file}`);
}


async function resolveIds() {
  const org = await db.query.organization.findFirst({
    where: eq(organization.slug, DEMO_ORG.slug),
    columns: { id: true },
  });
  if (!org) throw new Error("Demo org not found, run `npm run db:seed` first.");

  const byName = async (name: string) =>
    db.query.monitors.findFirst({
      where: and(eq(monitors.organizationId, org.id), eq(monitors.name, name)),
      columns: { id: true },
    });

  const gateway = await byName("API Gateway");
  const auth = await byName("Auth Service");
  const ongoing = await db.query.incidents.findFirst({
    where: and(
      eq(incidents.organizationId, org.id),
      ne(incidents.status, "resolved"),
    ),
    columns: { id: true },
  });
  if (!gateway || !auth || !ongoing) {
    throw new Error("Demo data incomplete, re-run `npm run db:seed`.");
  }

  return {
    monitorId: gateway.id,
    recoveryMonitorId: auth.id,
    incidentId: ongoing.id,
  };
}

async function signIn(page: Page) {
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill(DEMO_USERS.owner.email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
}

async function fullPage(
  page: Page,
  path: string,
  file: string,
  shows: string,
): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector("h1", { timeout: 20_000 });
  await page.waitForTimeout(900);
  await capture(page, file, shows);
}

async function main() {
  const ids = await resolveIds();

  const browser = await chromium.launch();
  // DPR 2: the site and the docs display these at up to their full
  // logical width, and a 1x capture reads soft on any dense display.
  // Crop arithmetic downstream stays in logical 1440x900 coordinates.
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await signIn(page);

  await fullPage(
    page,
    "/dashboard",
    "dashboard.png",
    "The dashboard: monitor states, open incidents and the setup checklist on seeded data",
  );
  await fullPage(
    page,
    `/monitors/${ids.monitorId}`,
    "monitor-detail.png",
    "A monitor's detail page: response-time chart, recent checks and configuration",
  );
  await fullPage(
    page,
    `/incidents/${ids.incidentId}`,
    "incident-detail.png",
    "An open incident: severity, lifecycle, and the append-only timeline",
  );
  await fullPage(
    page,
    `/status/${DEMO_ORG.slug}`,
    "status-page.png",
    "The public status page: components, 90-day uptime bars and incident history",
  );


  // The check-type selector, open, on the create-monitor dialog. The
  // point of the picture is the breadth of the list, so the capture is
  // the viewport with the listbox open rather than a crop of the dialog
  // (Radix renders the open listbox in a portal outside it).
  await page.goto(`${BASE}/monitors`);
  await page.getByRole("button", { name: "Create monitor" }).click();
  await page.getByRole("combobox").first().click();
  await page.waitForSelector('[role="listbox"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await capture(
    page,
    "monitor-types.png",
    "The check-type selector on the create-monitor form, one entry per registered type",
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");


  await fullPage(
    page,
    "/settings/import",
    "kuma-import.png",
    "The Uptime Kuma importer: upload a kuma.db, read the dry-run report, then apply",
  );
  await fullPage(
    page,
    "/settings/members",
    "roles.png",
    "The team page: owner, admin, responder and viewer on separate accounts",
  );
  await fullPage(
    page,
    "/settings/notifications",
    "notifications.png",
    "Notification channels: the provider editor, event-class routing and the delivery history",
  );
  // The delivery ledger: queue health, the states 1.18.0 separated, and
  // the attempt timeline behind one of them. The screenshot is worth
  // taking because "durable retries" is a claim about behaviour nobody
  // can see, and this is where an operator sees it.
  await page.goto(`${BASE}/settings/notifications?dstate=unhappy`);
  await page.waitForSelector("h1", { timeout: 20_000 });
  // The app scrolls inside its own container, so `fullPage` captures
  // the viewport and nothing below it. The ledger sits under the
  // channel list; scroll it into view or the screenshot shows the card
  // above the one it is named for.
  await page.getByText("Deliveries", { exact: true }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await capture(
    page,
    "notification-deliveries.png",
    "The delivery ledger: queue pressure, attempts spent, next retry, and why a message stopped",
  );

  await page.getByRole("button", { name: "Attempts" }).first().click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await capture(
    page,
    "notification-attempts.png",
    "One delivery's attempt timeline, including an attempt that never reported an outcome",
  );
  await page.keyboard.press("Escape");

  // The provider picker, open. The channel list shows what one
  // workspace configured; this shows what the product actually offers,
  // which is the thing a buyer is trying to find out - including the
  // Apprise row, labelled as a bridge rather than counted as native.
  await page.goto(`${BASE}/settings/notifications`);
  await page.waitForSelector("h1", { timeout: 20_000 });
  await page.getByRole("button", { name: "Add channel" }).click();
  await page.getByRole("dialog").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  await capture(
    page,
    "notification-providers.png",
    "The provider picker: searchable and grouped, each entry showing its pinned API version and what it can do",
  );
  await page.keyboard.press("Escape");

  await fullPage(
    page,
    "/status-page",
    "branding.png",
    "Status-page settings, including the white-label branding toggle",
  );


  // Public product captures use the supported dark theme. Keep the historic
  // -dark filenames as compatibility assets for existing marketing/doc links;
  // both sets are fresh captures of this build, never recolored copies.
  const darkPage = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  await signIn(darkPage);
  await fullPage(
    darkPage,
    "/dashboard",
    "dashboard-dark.png",
    "The dashboard in the native dark theme, using the legacy dark asset filename",
  );
  await fullPage(
    darkPage,
    `/incidents/${ids.incidentId}`,
    "incident-detail-dark.png",
    "The open incident in the native dark theme, using the legacy dark asset filename",
  );
  await fullPage(
    darkPage,
    "/settings/import",
    "kuma-import-dark.png",
    "The Uptime Kuma importer in the native dark theme, using the legacy dark asset filename",
  );

  await browser.close();

  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        _: "Written by scripts/capture-screenshots.ts. Verified by scripts/probe-shots-check.mjs.",
        capturedAt: new Date().toISOString().slice(0, 10),
        sourceCommit: headCommit(),
        base: BASE,
        shots: shots.sort((a, b) => a.file.localeCompare(b.file)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${MANIFEST} (${shots.length} shots)`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
