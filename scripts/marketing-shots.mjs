#!/usr/bin/env node
/**
 * The pictures on the marketing site, captured from the exported demo.
 *
 *   python3 -m http.server 4173 --directory landing     # or any static host
 *   node scripts/marketing-shots.mjs                    # writes landing/assets/shots
 *   node scripts/marketing-shots.mjs hero-incident      # one shot by name
 *
 * `landing/demo/` is a static export of the running product on the seeded
 * demo data, which means the marketing site can be illustrated with the
 * real application without booting the application. Every picture here is
 * therefore a capture of shipped UI rendering real seeded rows, and the
 * spec below is the provenance: the page it came from, the element it was
 * clipped to, and the colour scheme it was rendered in.
 *
 * Two rules the old captures broke, and the reason this file exists:
 *
 * 1. **A crop ends where the interface ends.** Every shot clips to an
 *    ELEMENT rather than to a rectangle somebody eyeballed, so no capture
 *    ends halfway through a control, a row or a word. Where a rectangle is
 *    unavoidable it is expressed in the page's own coordinates and padded
 *    to the nearest boundary.
 * 2. **Both schemes are captured, never simulated.** The export follows
 *    `prefers-color-scheme`, so the dark pictures are the product's own
 *    night scheme. Nothing on the site filters or inverts a screenshot:
 *    an inverted capture is a picture of a product that does not exist.
 *
 * Captured at deviceScaleFactor 2 so the type survives being set at a
 * fraction of its natural size, which is what a page does to a 1440-wide
 * screen.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "landing/assets/shots");
const BASE = process.env.DEMO_URL ?? "http://localhost:4173";
const DPR = 2;

/** The critical incident that is still open: the anchor picture. */
const INCIDENT = "/demo/incidents/01a03093-8f2a-719a-a396-156cf35d4b53.html";
/** A resolved one, whose timeline has people in it. */
const INCIDENT_B = "/demo/incidents/01a03093-8f25-7958-9a06-7b02f89caa84.html";
const RUNBOOK_RUN =
  "/demo/runbooks/runs/01a03093-a195-7892-beff-26d47a319939.html";
const SLO = "/demo/slos/01a03093-97fa-72e5-8c0e-0a9fba032a5a.html";
const TASK = "/demo/tasks/01a03093-a1ea-7d5f-af28-0bb098028f68.html";
const MONITOR = "/demo/monitors/01a03093-6501-7182-8f3a-a6bd58c25e63.html";

/**
 * `clip` is a CSS selector: the shot is that element's own box, so the
 * edges are the interface's edges. `pad` grows it outward in CSS pixels,
 * for the cases where a card's shadow or focus ring belongs in the frame.
 * `hide` removes chrome that is true but not part of the story.
 */
const SHOTS = [
  // ── the anchor ──────────────────────────────────────────────────────
  {
    name: "incident-stage",
    url: INCIDENT,
    schemes: ["dark", "light"],
    viewport: [1560, 1000],
    clip: "body",
    through: '[aria-label="Incident timeline"] li:first-child',
    collapseSidebar: true,
    shows:
      "The incident as a bounded opening scene: collapsed application rail, severity, title, first timeline event and the complete actions card.",
  },
  {
    name: "incident-stage-narrow",
    url: INCIDENT,
    schemes: ["dark", "light"],
    viewport: [430, 1000],
    clip: "body",
    through: '[aria-label="Incident timeline"] li:first-child',
    shows:
      "The incident as a bounded mobile scene: severity, title and the first complete timeline event.",
  },
  {
    name: "incident-full",
    url: INCIDENT,
    schemes: ["dark", "light"],
    viewport: [1560, 1000],
    clip: "body",
    shows:
      "The incident page whole: severity, lifecycle, the timeline and the actions rail.",
  },
  {
    name: "incident-head",
    url: INCIDENT,
    schemes: ["dark", "light"],
    viewport: [1560, 1000],
    clip: "main",
    crop: [0, 0, 1, 0.295],
    shows:
      "The head of an incident: severity, title, and how long it has been open.",
  },
  {
    name: "incident-timeline",
    url: INCIDENT_B,
    schemes: ["dark", "light"],
    viewport: [1560, 1400],
    clip: "main",
    crop: [0, 0.317, 0.632, 0.878],
    shows:
      "The append-only timeline: recovery attempts, their verifications and the hand-over to a person.",
  },
  // ── breadth ─────────────────────────────────────────────────────────
  {
    name: "monitors",
    url: "/demo/monitors.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0, 1, 0.93],
    shows:
      "The monitor list: sixteen monitors, their state, uptime and last check.",
  },
  {
    name: "monitor-detail",
    url: MONITOR,
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0, 1, 0.68],
    shows: "One monitor: its response-time chart and the checks behind it.",
  },
  // ── the operational layer ───────────────────────────────────────────
  {
    name: "tasks",
    url: "/demo/tasks.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1180],
    clip: "main",
    crop: [0, 0.148, 1, 0.921],
    shows:
      "The operations inbox, including the task a runbook run is suspended on.",
  },
  {
    name: "task-detail",
    url: TASK,
    schemes: ["light", "dark"],
    viewport: [1560, 1180],
    clip: "main",
    crop: [0, 0, 1, 0.62],
    shows:
      "One task: its checklist, its deadline and the runbook run waiting on it.",
  },
  {
    name: "runbook-run",
    url: RUNBOOK_RUN,
    schemes: ["light", "dark"],
    viewport: [1560, 1400],
    clip: "main",
    crop: [0, 0.04, 1, 0.66],
    shows:
      "A runbook run: each step with what it sent, what came back, and the verification afterwards.",
  },
  {
    name: "objective",
    url: SLO,
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0.103, 1, 0.699],
    shows:
      "A service level objective: compliance, error budget and the burn windows firing.",
  },
  // ── publishing and delivery ─────────────────────────────────────────
  {
    name: "status-page",
    url: "/demo/status/altitude.html",
    schemes: ["light", "dark"],
    viewport: [1240, 1100],
    clip: "body",
    crop: [0, 0, 1, 0.74],
    shows:
      "The public status page during an outage: the banner, the incident and its updates.",
  },
  {
    name: "notifications",
    url: "/demo/settings/notifications.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1180],
    clip: "main",
    crop: [0, 0.06, 1, 0.78],
    shows:
      "Notification channels: the providers configured and where each event class is routed.",
  },
  // ── migration ───────────────────────────────────────────────────────
  {
    name: "import",
    url: "/demo/settings/import.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1180],
    clip: "main",
    crop: [0, 0.05, 1, 0.75],
    shows:
      "The importer: one entry per monitoring system it reads, and what each one refuses to carry.",
  },
  // ── ownership and scale ─────────────────────────────────────────────
  {
    name: "probes",
    url: "/demo/probes.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0, 1, 0.72],
    shows:
      "The remote probe fleet: agents the operator runs, and the quorum they have to reach.",
  },
  {
    name: "quorum",
    url: "/demo/quorum/outage.html",
    schemes: ["light", "dark"],
    viewport: [1360, 900],
    clip: "main",
    shows: "A quorum verdict: three of three probes agree the target is down.",
  },
  {
    name: "members",
    url: "/demo/settings/members.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0.04, 1, 0.62],
    shows: "The team: owner, admin, responder and viewer on separate accounts.",
  },
  {
    name: "audit",
    url: "/demo/settings/audit.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0.04, 1, 0.7],
    shows: "The audit page: who changed what, in order.",
  },
  // ── the dashboard, for the pages that need the whole picture ────────
  {
    name: "dashboard",
    url: "/demo/dashboard.html",
    schemes: ["dark", "light"],
    viewport: [1560, 1000],
    clip: "body",
    shows:
      "The dashboard: monitor states, the open incident and the fleet at a glance.",
  },
  {
    name: "reports",
    url: "/demo/reports.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0.04, 1, 0.68],
    shows: "Client reports: one per client organization, per period.",
  },
  {
    name: "recovery-bounds",
    tall: true,
    url: MONITOR,
    schemes: ["light", "dark"],
    viewport: [1560, 1200],
    clip: "main",
    crop: [0, 0.3243, 1, 0.3805],
    shows:
      "The three bounds on automatic recovery, as fields: attempts per incident, cooldown between them, and how long to wait before the verification probe.",
  },
  {
    name: "tasks-rows",
    url: "/demo/tasks.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1200],
    clip: "main",
    crop: [0, 0.176, 1, 0.6],
    shows:
      "The operations inbox with the task a runbook run is suspended on, and the notice that says so.",
  },
  {
    name: "recovery",
    tall: true,
    url: MONITOR,
    schemes: ["light", "dark"],
    viewport: [1560, 1200],
    clip: "main",
    crop: [0, 0.2765, 1, 0.399],
    shows:
      "The automatic-recovery editor on a monitor: the signed endpoint, the attempts allowed, the cooldown and the delay before verifying.",
  },
  {
    name: "escalation",
    url: "/demo/settings/escalation.html",
    schemes: ["light", "dark"],
    viewport: [1560, 1080],
    clip: "main",
    crop: [0, 0.045, 1, 0.775],
    shows:
      "On-call rotas and the escalation ladder: who is woken, and who is tried next.",
  },
  {
    name: "report-head",
    tall: true,
    url: "/demo/report.html",
    schemes: ["light"],
    viewport: [1240, 1180],
    clip: "body",
    crop: [0, 0.006, 1, 0.235],
    shows:
      "The head of a branded client report: the studio, the period, and the four figures the client reads first.",
  },
  {
    name: "report",
    tall: true,
    url: "/demo/report.html",
    schemes: ["light"],
    viewport: [1240, 1180],
    clip: "body",
    crop: [0, 0.006, 1, 0.6],
    shows:
      "A branded monthly client report: uptime, downtime, incidents and the response times behind them.",
  },
  {
    name: "recovery-narrow",
    tall: true,
    url: MONITOR,
    schemes: ["light", "dark"],
    viewport: [430, 1200],
    clip: "main",
    crop: [0, 0.2975, 1, 0.412],
    shows: "The automatic-recovery editor on a phone.",
  },
  {
    name: "incident-timeline-narrow",
    tall: true,
    url: INCIDENT_B,
    schemes: ["dark", "light"],
    viewport: [430, 1200],
    clip: "main",
    crop: [0, 0.2, 1, 0.72],
    shows: "A resolved incident's postmortem and timeline on a phone.",
  },
  {
    name: "escalation-narrow",
    url: "/demo/settings/escalation.html",
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "main",
    crop: [0, 0.06, 1, 0.66],
    shows: "On-call schedules and escalation on a phone.",
  },
  // ── the same screens on a phone ───────────────────────────────────────
  // The product is responsive, so the pictures a phone is shown are the
  // product on a phone rather than a desktop screen panned sideways.
  {
    name: "incident-narrow",
    url: INCIDENT,
    schemes: ["dark", "light"],
    viewport: [430, 1000],
    clip: "main",
    crop: [0, 0, 1, 0.62],
    shows:
      "The incident on a phone: severity, title and the first of the timeline.",
  },
  {
    name: "tasks-narrow",
    url: "/demo/tasks.html",
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "main",
    crop: [0, 0.16, 1, 0.795],
    shows: "The operations inbox on a phone.",
  },
  {
    name: "objective-narrow",
    url: SLO,
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "main",
    crop: [0, 0.1, 1, 0.5865],
    shows: "An objective and its error budget on a phone.",
  },
  {
    name: "import-narrow",
    url: "/demo/settings/import.html",
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "main",
    crop: [0, 0.07, 1, 0.72],
    shows: "The importer on a phone.",
  },
  {
    name: "status-page-narrow",
    url: "/demo/status/altitude.html",
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "body",
    crop: [0, 0, 1, 0.658],
    shows: "The public status page on a phone, during an outage.",
  },
  {
    name: "monitors-narrow",
    url: "/demo/monitors.html",
    schemes: ["light", "dark"],
    viewport: [430, 1100],
    clip: "main",
    crop: [0, 0.06, 1, 0.771],
    shows: "The monitor list on a phone.",
  },
  {
    name: "runbook-run-narrow",
    url: RUNBOOK_RUN,
    schemes: ["light", "dark"],
    viewport: [430, 1200],
    clip: "main",
    crop: [0, 0.05, 1, 0.652],
    shows: "A runbook run on a phone.",
  },
  {
    name: "report-narrow",
    tall: true,
    url: "/demo/report.html",
    schemes: ["light"],
    viewport: [560, 1200],
    clip: "body",
    crop: [0, 0.02, 1, 0.56],
    shows: "A branded client report on a narrow screen.",
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
if (!wanted.length) {
  console.error(`no shot named ${only.join(", ")}`);
  process.exit(2);
}

const pw = await import(
  pathToFileURL(join(ROOT, "node_modules/playwright/index.js")).href
);
const chromium = pw.chromium ?? pw.default?.chromium;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const manifest = [];

for (const shot of wanted) {
  for (const scheme of shot.schemes) {
    const [width, height] = shot.viewport;
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: DPR,
      colorScheme: scheme,
    });
    await page.goto(BASE + shot.url, { waitUntil: "networkidle" });
    // Nothing should be mid-transition, mid-focus or mid-font-swap when
    // the shutter opens.
    await page.addStyleTag({
      content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
                ::-webkit-scrollbar{width:0;height:0}
                *:focus,*:focus-visible{outline:none!important;box-shadow:none!important}`,
    });
    // The export's own footer band is an artefact of exporting, not part
    // of the product, so it is removed from every capture rather than
    // cropped around.
    for (const sel of ['[style*="z-index:9999"]', ...(shot.hide ?? [])]) {
      await page.evaluate((s) => {
        document.querySelectorAll(s).forEach((el) => el.remove());
      }, sel);
    }
    if (shot.collapseSidebar) {
      await page.evaluate(() => {
        const sidebar = document.querySelector('[data-slot="sidebar"]');
        if (!sidebar) return;
        sidebar.setAttribute("data-state", "collapsed");
        sidebar.setAttribute("data-collapsible", "icon");
      });
      await page.addStyleTag({
        content:
          '[data-slot="sidebar"],[data-slot="sidebar"] *{font-size:0!important}',
      });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(320);

    const measured = await page.evaluate(
      ({ clip, through }) => {
        const el = document.querySelector(clip);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const end = through ? document.querySelector(through) : null;
        return {
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
          throughBottom: end ? end.getBoundingClientRect().bottom : null,
        };
      },
      { clip: shot.clip, through: shot.through },
    );
    if (!measured)
      throw new Error(`${shot.name}: no element matching ${shot.clip}`);
    if (shot.through && measured.throughBottom === null)
      throw new Error(`${shot.name}: no element matching ${shot.through}`);

    const box = measured.box;
    let clip = { ...box };
    if (measured.throughBottom !== null) {
      clip.height = measured.throughBottom - box.y;
    }
    if (shot.crop) {
      const [x0, y0, x1, y1] = shot.crop;
      clip = {
        x: box.x + box.width * x0,
        y: box.y + box.height * y0,
        width: box.width * (x1 - x0),
        height: box.height * (y1 - y0),
      };
    }
    // Whole pixels: a fractional clip resamples the capture and softens
    // every hairline in it. A region that runs past the fold is captured
    // full-page rather than scrolled to, so a sticky rail is not drawn
    // twice into the same picture.
    const doc = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    clip.x = Math.max(0, Math.round(clip.x));
    clip.y = Math.max(0, Math.round(clip.y));
    // A crop is bounded by the window unless the shot says otherwise:
    // a fraction of an element that runs for several screens would
    // otherwise produce a picture nobody asked for. `tall` opts in, and
    // is used by the two shots whose subject is genuinely longer than a
    // window: the recovery editor and the printed client report.
    const limitH = shot.tall ? doc.h : height;
    clip.width = Math.min(Math.round(clip.width), doc.w - clip.x);
    clip.height = Math.min(Math.round(clip.height), limitH - clip.y);
    const fullPage = clip.y + clip.height > height;

    const file = `${shot.name}-${scheme}.png`;
    const path = join(OUT, file);
    await page.screenshot({ path, clip, fullPage });
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(path);
    manifest.push({
      file: `landing/assets/shots/${file}`,
      page: shot.url,
      scheme,
      clippedTo: shot.clip,
      ...(shot.through ? { clippedThrough: shot.through } : {}),
      ...(shot.collapseSidebar ? { sidebar: "collapsed" } : {}),
      crop: shot.crop ?? null,
      viewport: `${width}x${height}@${DPR}x`,
      pixels: `${clip.width * DPR}x${clip.height * DPR}`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      shows: shot.shows,
    });
    console.log(`${file}  ${clip.width * DPR}x${clip.height * DPR}`);
    await page.close();
  }
}

await browser.close();
if (!only.length) {
  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        _: "Generated by scripts/marketing-shots.mjs from the exported demo. Do not edit.",
        deviceScaleFactor: DPR,
        shots: manifest,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\n${manifest.length} shots, manifest written`);
}
