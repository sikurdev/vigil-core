import "dotenv/config";
import "./_force-non-demo";

import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  auditLogs,
  incidentEvents,
  incidents,
  member,
  monitorChecks,
  monitors,
  notificationChannelMonitors,
  notificationChannels,
  notificationAttempts,
  notificationOutbox,
  organization,
  statusPageMonitors,
  statusPages,
  statusPageSubscribers,
  user,
} from "@/db/schema";
import { auth } from "@/lib/auth";
import { sealSecrets } from "@/modules/notifications/secretbox";
import { DEMO_ORG, DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo";

/**
 * Seeds a realistic demo tenant: a team, eleven production-style
 * monitors covering six check types, with 90 days of check history,
 * one fully resolved incident (timeline + postmortem), one ongoing
 * outage, and a recovery action with two quiet self-healed incidents
 * (the runtime fixed them; nobody was paged).
 * Idempotent — re-running wipes and recreates the demo organization, so
 * it doubles as the nightly demo reset (see docs/DEMO.md).
 *
 *   npm run db:seed
 */

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Deterministic pseudo-random so re-seeds produce comparable charts. */
function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260702);

interface MonitorSeed {
  name: string;
  url: string;
  /** Defaults to `http`; the demo uses six of the registered types. */
  checkType?: string;
  port?: number;
  /** Type-specific settings for the types that use the config blob. */
  config?: Record<string, unknown>;
  method?: "GET" | "HEAD";
  intervalSeconds: number;
  expectedStatusCode?: number;
  baseMs: number;
  publicName: string;
  /** UTC ms outage windows: checks inside fail. */
  outages?: [number, number][];
}

async function wipe(): Promise<void> {
  const existing = await db.query.organization.findFirst({
    where: eq(organization.slug, DEMO_ORG.slug),
    columns: { id: true },
  });
  if (existing) {
    await db.delete(organization).where(eq(organization.id, existing.id));
  }
  const emails = Object.values(DEMO_USERS).map((u) => u.email);
  await db.delete(user).where(inArray(user.email, emails));
}

async function createTeam() {
  const ids: Record<keyof typeof DEMO_USERS, string> = {
    owner: "",
    admin: "",
    responder: "",
    viewer: "",
  };
  for (const [key, profile] of Object.entries(DEMO_USERS)) {
    const result = await auth.api.signUpEmail({
      body: {
        name: profile.name,
        email: profile.email,
        password: DEMO_PASSWORD,
      },
    });
    ids[key as keyof typeof DEMO_USERS] = result.user.id;
  }

  const organizationId = randomUUID();
  await db.insert(organization).values({
    id: organizationId,
    name: DEMO_ORG.name,
    slug: DEMO_ORG.slug,
    createdAt: new Date(Date.now() - 92 * DAY),
  });
  await db.insert(member).values(
    Object.entries(DEMO_USERS).map(([key, profile]) => ({
      id: randomUUID(),
      organizationId,
      userId: ids[key as keyof typeof DEMO_USERS],
      role: profile.role,
      createdAt: new Date(Date.now() - 91 * DAY),
    })),
  );
  return { organizationId, ids };
}

/**
 * How often the seed writes a check, and why it is not "whatever looks
 * like enough".
 *
 * An observation stands for at most three of the monitor's configured
 * intervals (`coverageHorizonMs`), and anything past that is reported as
 * *unmeasured* rather than as uptime. So a demo that writes a row every
 * three hours for a 60-second monitor is not a sparser version of the
 * real thing — it is a monitor with 1.7% coverage, and every surface
 * that shows coverage says so, correctly and unhelpfully.
 *
 * Two and a half intervals is the cheapest cadence that leaves no gap:
 * comfortably inside the three-interval horizon even after the jitter
 * below, and 2.5x fewer rows than probing at the interval itself. For a
 * 60-second monitor over a month that is ~18k rows instead of ~45k.
 */
function seedCadenceMs(intervalSeconds: number): number {
  return intervalSeconds * 2_500;
}

function checkRowsFor(
  monitorId: string,
  seed: MonitorSeed,
  now: number,
  denseFrom: number,
): (typeof monitorChecks.$inferInsert)[] {
  const rows: (typeof monitorChecks.$inferInsert)[] = [];
  const start = now - 90 * DAY;

  const push = (ts: number) => {
    const inOutage = seed.outages?.some(([from, to]) => ts >= from && ts <= to);
    const responseTimeMs = Math.round(seed.baseMs * (0.8 + rand() * 0.6));
    rows.push({
      monitorId,
      checkedAt: new Date(ts),
      ok: !inOutage,
      statusCode: inOutage ? 502 : (seed.expectedStatusCode ?? 200),
      responseTimeMs: inOutage ? Math.round(seed.baseMs * 3) : responseTimeMs,
      error: inOutage ? "Unexpected status 502" : null,
    });
  };

  // Older than the reporting window: three-hourly. The 90-day strip
  // reads it fine and nothing claims full coverage back there.
  for (let ts = start; ts < denseFrom; ts += 3 * 60 * MIN + rand() * 10 * MIN) {
    push(ts);
  }
  // The reporting window — last complete month through to now — at the
  // monitor's own cadence, so a report over it is fully covered and the
  // percentages mean what a client will read them as.
  const cadence = seedCadenceMs(seed.intervalSeconds);
  for (let ts = denseFrom; ts < now; ts += cadence * (0.97 + rand() * 0.05)) {
    push(ts);
  }
  return rows;
}

async function main() {
  console.log("Seeding demo data…");
  await wipe();
  const { organizationId, ids } = await createTeam();
  const now = Date.now();

  // The last complete calendar month in UTC — the period a monthly
  // client report defaults to. Computed here rather than imported from
  // `modules/reports`, which is commercial code this seed must not
  // depend on: what follows is fixture placement, not the report's
  // definition of a period.
  const today = new Date(now);
  const lastMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1),
  );
  /** A UTC instant inside the last complete month. Days 1–28 only. */
  const inLastMonth = (day: number, hour: number, minute = 0) =>
    Date.UTC(
      lastMonth.getUTCFullYear(),
      lastMonth.getUTCMonth(),
      day,
      hour,
      minute,
    );

  const gatewayOutage: [number, number] = [
    now - 6 * DAY - 55 * MIN,
    now - 6 * DAY - 22 * MIN,
  ];
  // An outage inside the last complete month, so the monthly client
  // report always has a real one to show rather than a green page that
  // proves nothing. 47 minutes, at the hour when nobody is watching.
  const lastMonthOutage: [number, number] = [
    inLastMonth(12, 3, 14),
    inLastMonth(12, 4, 1),
  ];
  const checkoutDownSince = now - 38 * MIN;
  // Two short Auth Service blips the recovery runtime healed quietly.
  // The second is anchored inside the last complete month so a monthly
  // report carries recovery evidence and not just an outage.
  const authBlips: { start: number; verifySeconds: number; ms: number }[] = [
    { start: now - 9 * DAY - 47 * MIN, verifySeconds: 41, ms: 152 },
    { start: inLastMonth(19, 22, 6), verifySeconds: 53, ms: 187 },
  ];

  const seeds: MonitorSeed[] = [
    {
      name: "API Gateway",
      url: "https://api.github.com",
      intervalSeconds: 60,
      baseMs: 140,
      publicName: "API",
      outages: [gatewayOutage, lastMonthOutage],
    },
    {
      name: "Marketing Site",
      url: "https://example.com",
      intervalSeconds: 300,
      baseMs: 90,
      publicName: "Website",
    },
    {
      name: "Documentation",
      url: "https://developer.mozilla.org",
      intervalSeconds: 300,
      baseMs: 180,
      publicName: "Docs",
    },
    {
      name: "CDN Edge",
      url: "https://www.cloudflare.com",
      method: "HEAD",
      intervalSeconds: 120,
      baseMs: 60,
      publicName: "CDN",
    },
    {
      name: "Auth Service",
      url: "https://www.google.com/generate_204",
      intervalSeconds: 60,
      expectedStatusCode: 204,
      baseMs: 110,
      publicName: "Authentication",
      outages: authBlips.map(
        (blip) => [blip.start, blip.start + 4 * MIN] as [number, number],
      ),
    },
    {
      name: "Checkout Service",
      url: "https://checkout.altitude-demo.example",
      intervalSeconds: 60,
      baseMs: 220,
      publicName: "Checkout",
      outages: [[checkoutDownSince, now]],
    },
    {
      name: "Primary database port",
      url: "db.altitude-demo.example",
      checkType: "tcp",
      port: 5432,
      intervalSeconds: 60,
      baseMs: 8,
      publicName: "Database",
    },
    {
      name: "Edge gateway reachability",
      url: "one.one.one.one",
      checkType: "ping",
      intervalSeconds: 60,
      baseMs: 14,
      publicName: "Network edge",
    },
    {
      name: "Apex DNS record",
      url: "altitude-demo.example",
      checkType: "dns",
      config: { recordType: "A", expectedValue: null },
      intervalSeconds: 300,
      baseMs: 28,
      publicName: "DNS",
    },
    {
      name: "TLS certificate for altitude-demo.example",
      url: "altitude-demo.example",
      checkType: "tls-expiry",
      port: 443,
      config: { warnDays: 14 },
      intervalSeconds: 3600,
      baseMs: 62,
      publicName: "TLS certificate",
    },
    {
      name: "Domain registration",
      url: "altitude-demo.example",
      checkType: "domain-expiry",
      config: { warnDays: 30 },
      intervalSeconds: 3600,
      baseMs: 180,
      publicName: "Domain registration",
    },
  ];

  const monitorIds: Record<string, string> = {};
  for (const seed of seeds) {
    const isDown = seed.name === "Checkout Service";
    const [row] = await db
      .insert(monitors)
      .values({
        organizationId,
        createdBy: ids.owner,
        name: seed.name,
        url: seed.url,
        method: seed.method ?? "GET",
        intervalSeconds: seed.intervalSeconds,
        expectedStatusCode: seed.expectedStatusCode ?? null,
        checkType: seed.checkType ?? "http",
        config: seed.config ?? null,
        port: seed.port ?? null,
        // One interval of failing before an incident opens — the
        // time-based equivalent of the old failureThreshold: 2.
        failureWindowSeconds: seed.intervalSeconds,
        currentStatus: isDown ? "down" : "up",
        consecutiveFailures: isDown ? 38 : 0,
        firstFailureAt: isDown ? new Date(checkoutDownSince) : null,
        lastCheckedAt: new Date(now - 2 * MIN),
        nextEvaluationAt: new Date(now + seed.intervalSeconds * 1000),
        createdAt: new Date(now - 89 * DAY),
      })
      .returning({ id: monitors.id });
    if (!row) throw new Error(`monitor insert failed: ${seed.name}`);
    monitorIds[seed.name] = row.id;

    const rows = checkRowsFor(row.id, seed, now, lastMonth.getTime());
    for (let i = 0; i < rows.length; i += 2000) {
      await db.insert(monitorChecks).values(rows.slice(i, i + 2000));
    }
  }

  // --- Resolved incident with a complete lifecycle + postmortem --------
  const [resolved] = await db
    .insert(incidents)
    .values({
      organizationId,
      title: "Elevated 5xx responses on the API Gateway",
      status: "resolved",
      severity: "major",
      source: "monitor",
      monitorId: monitorIds["API Gateway"],
      startedAt: new Date(gatewayOutage[0] + 2 * MIN),
      resolvedAt: new Date(gatewayOutage[1] + 5 * MIN),
      createdAt: new Date(gatewayOutage[0] + 2 * MIN),
      notifiedAt: new Date(gatewayOutage[0] + 2 * MIN),
      postmortem: [
        "## Summary",
        "Between 14:05 and 14:38 UTC the API Gateway returned 502s for roughly a third of requests after a routine deploy exhausted the upstream connection pool.",
        "",
        "## Impact",
        "~33 minutes of degraded API availability. Dashboard and status page remained up; webhook deliveries were delayed but not lost.",
        "",
        "## Timeline",
        "See the incident timeline. Detection was automatic (2 consecutive failed checks), rollback restored service in 26 minutes.",
        "",
        "## Root cause",
        "The 14:02 deploy halved `upstream_pool_size` via a misread config template. Connections saturated within three minutes under normal load.",
        "",
        "## What went well / what went poorly",
        "- Well: automatic detection paged the on-call within a minute; rollback path worked first try.",
        "- Poorly: the config change slipped through review; canary coverage does not include pool-limit regressions.",
        "",
        "## Action items",
        "- [x] Roll back and pin `upstream_pool_size`",
        "- [ ] Add config-diff linting for capacity-affecting keys",
        "- [ ] Extend canary checks to catch connection-pool saturation",
      ].join("\n"),
      createdBy: null,
    })
    .returning({ id: incidents.id });
  if (!resolved) throw new Error("resolved incident insert failed");

  const t0 = gatewayOutage[0] + 2 * MIN;
  await db.insert(incidentEvents).values([
    {
      incidentId: resolved.id,
      type: "created",
      status: "investigating",
      message: "API Gateway had been failing for 1 minute and was marked down.",
      createdBy: null,
      createdAt: new Date(t0),
    },
    {
      incidentId: resolved.id,
      type: "update",
      message:
        "Seeing sustained 502s from the gateway since 14:05. Checking the 14:02 deploy first.",
      createdBy: ids.responder,
      createdAt: new Date(t0 + 6 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "status_change",
      status: "identified",
      message:
        "Root cause identified: the 14:02 deploy reduced the upstream connection pool. Rolling back now.",
      createdBy: ids.responder,
      createdAt: new Date(t0 + 12 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "status_change",
      status: "monitoring",
      message:
        "Rollback deployed. Error rate back to baseline, monitoring for regressions.",
      createdBy: ids.admin,
      createdAt: new Date(t0 + 24 * MIN),
    },
    {
      incidentId: resolved.id,
      type: "status_change",
      status: "resolved",
      message:
        "Stable for 10 minutes across all regions. Resolving; postmortem to follow.",
      createdBy: ids.admin,
      createdAt: new Date(gatewayOutage[1] + 5 * MIN),
    },
  ]);

  // --- Last month's incident: acknowledged, then resolved ---------------
  // The one that makes a monthly report a document rather than a table.
  // It carries an acknowledgement, which is the only thing MTTA can be
  // measured from — an incident nobody acked in Vigil leaves that figure
  // blank, correctly, and a demo where every figure is blank teaches
  // nothing.
  const lastMonthOpened = lastMonthOutage[0] + 2 * MIN;
  const [lastMonthIncident] = await db
    .insert(incidents)
    .values({
      organizationId,
      title: "API Gateway unreachable from the edge",
      status: "resolved",
      severity: "major",
      source: "monitor",
      monitorId: monitorIds["API Gateway"],
      startedAt: new Date(lastMonthOpened),
      acknowledgedAt: new Date(lastMonthOpened + 11 * MIN),
      acknowledgedBy: ids.responder,
      resolvedAt: new Date(lastMonthOutage[1] + 3 * MIN),
      createdAt: new Date(lastMonthOpened),
      notifiedAt: new Date(lastMonthOpened),
      createdBy: null,
    })
    .returning({ id: incidents.id });
  if (!lastMonthIncident) throw new Error("last-month incident insert failed");

  await db.insert(incidentEvents).values([
    {
      incidentId: lastMonthIncident.id,
      type: "created",
      status: "investigating",
      message: "API Gateway had been failing for 1 minute and was marked down.",
      createdBy: null,
      createdAt: new Date(lastMonthOpened),
    },
    {
      incidentId: lastMonthIncident.id,
      type: "update",
      message:
        "Acknowledged. Gateway health checks failing from every region; upstreams themselves look healthy.",
      createdBy: ids.responder,
      createdAt: new Date(lastMonthOpened + 11 * MIN),
    },
    {
      incidentId: lastMonthIncident.id,
      type: "status_change",
      status: "identified",
      message:
        "The edge load balancer dropped the gateway from its pool after a failed health-check threshold change.",
      createdBy: ids.responder,
      createdAt: new Date(lastMonthOpened + 26 * MIN),
    },
    {
      incidentId: lastMonthIncident.id,
      type: "status_change",
      status: "resolved",
      message:
        "Threshold reverted and the gateway is back in the pool. Traffic normal for 10 minutes.",
      createdBy: ids.admin,
      createdAt: new Date(lastMonthOutage[1] + 3 * MIN),
    },
  ]);

  // --- Ongoing critical incident ---------------------------------------
  const [ongoing] = await db
    .insert(incidents)
    .values({
      organizationId,
      title: "Checkout Service is down",
      status: "identified",
      severity: "critical",
      source: "monitor",
      monitorId: monitorIds["Checkout Service"],
      startedAt: new Date(checkoutDownSince + 2 * MIN),
      createdAt: new Date(checkoutDownSince + 2 * MIN),
      notifiedAt: new Date(checkoutDownSince + 2 * MIN),
      createdBy: null,
    })
    .returning({ id: incidents.id });
  if (!ongoing) throw new Error("ongoing incident insert failed");

  await db.insert(incidentEvents).values([
    {
      incidentId: ongoing.id,
      type: "created",
      status: "investigating",
      message:
        "Checkout Service had been failing for 1 minute and was marked down.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 2 * MIN),
    },
    // Recovery tried first — and lost. That's the escalation story: the
    // runtime stands down honestly and the humans below take over.
    {
      incidentId: ongoing.id,
      type: "system",
      message:
        "Automatic recovery attempt 1 of 2 started for Checkout Service.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 2 * MIN + 15 * 1000),
    },
    {
      incidentId: ongoing.id,
      type: "system",
      message:
        "Recovery attempt 1 did not restore Checkout Service, post-recovery verification still failing.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 3 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "system",
      message: "Next automatic recovery attempt in 120 seconds.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 3 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "system",
      message:
        "Recovery attempt 2 did not restore Checkout Service, post-recovery verification still failing.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 6 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "system",
      message:
        "Automatic recovery exhausted after 2 attempts, waiting for a human.",
      createdBy: null,
      createdAt: new Date(checkoutDownSince + 6 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "update",
      message:
        "DNS for the checkout upstream stopped resolving after the infrastructure change. Both restart attempts failed verification, so the attempt limit stopped automation. The missing CNAME needs a manual DNS repair. Escalated to the platform team.",
      createdBy: ids.responder,
      createdAt: new Date(checkoutDownSince + 9 * MIN),
    },
    {
      incidentId: ongoing.id,
      type: "status_change",
      status: "identified",
      message:
        "Confirmed: the zone migration dropped the checkout CNAME. Re-creating the record; ETA ~20 minutes.",
      createdBy: ids.admin,
      createdAt: new Date(checkoutDownSince + 16 * MIN),
    },
  ]);

  // --- Public status page ----------------------------------------------
  const [page] = await db
    .insert(statusPages)
    .values({
      organizationId,
      slug: DEMO_ORG.slug,
      name: `${DEMO_ORG.name} Status`,
      published: true,
      createdAt: new Date(now - 89 * DAY),
    })
    .returning({ id: statusPages.id });
  if (!page) throw new Error("status page insert failed");

  await db.insert(statusPageMonitors).values(
    seeds.map((seed, index) => ({
      statusPageId: page.id,
      monitorId: monitorIds[seed.name]!,
      displayName: seed.publicName,
      sortOrder: index,
    })),
  );

  // A few status-page subscribers: confirmed ones are emailed on incidents,
  // one pending row shows the double opt-in state on the settings page.
  await db.insert(statusPageSubscribers).values([
    {
      statusPageId: page.id,
      email: "ops@customer.example",
      confirmedAt: new Date(now - 80 * DAY),
    },
    {
      statusPageId: page.id,
      email: "sre@partner.example",
      confirmedAt: new Date(now - 40 * DAY),
    },
    { statusPageId: page.id, email: "pending@lead.example" },
  ]);

  // --- A believable audit trail ----------------------------------------
  await db.insert(auditLogs).values(
    seeds.map((seed) => ({
      organizationId,
      actorId: ids.owner,
      action: "monitor.created",
      targetType: "monitor",
      targetId: monitorIds[seed.name]!,
      metadata: { name: seed.name, url: seed.url },
      createdAt: new Date(now - 89 * DAY),
    })),
  );
  await db.insert(auditLogs).values({
    organizationId,
    actorId: ids.admin,
    action: "status_page.updated",
    targetType: "status_page",
    targetId: page.id,
    metadata: { slug: DEMO_ORG.slug, published: true },
    createdAt: new Date(now - 88 * DAY),
  });

  // Notification channels, so the settings page and its screenshot show
  // the editor with real rows. Credentials are obviously fake but sealed
  // exactly as the product seals them; the delivery history is seeded in
  // terminal states the outbox really produces.
  const [slackChannel] = await db
    .insert(notificationChannels)
    .values({
      organizationId,
      name: "Slack - Operations",
      provider: "slack",
      config: {},
      secrets: sealSecrets({
        webhookUrl:
          "https://hooks.slack.com/services/T0DEMO/B0DEMO/demo-not-real",
      }),
      destination: "hooks.slack.com/[redacted]",
      events: ["monitor", "incident"],
      enabled: true,
    })
    .returning();
  // The 1.17.0 wave, so the settings screenshot shows what the product
  // actually offers rather than four rows of chat webhooks: a pager with
  // a lifecycle, a ticket queue, a self-hosted chat server, an SMS
  // sender - and the Apprise bridge, named as a bridge.
  const [pagerdutyChannel] = await db
    .insert(notificationChannels)
    .values({
      organizationId,
      name: "PagerDuty - Critical services",
      provider: "pagerduty",
      config: { region: "us" },
      secrets: sealSecrets({ routingKey: `R${"0".repeat(31)}` }),
      destination: "PagerDuty service (US)",
      events: ["monitor", "incident"],
      enabled: true,
    })
    .returning();
  await db.insert(notificationChannels).values({
    organizationId,
    name: "Jira - Service desk",
    provider: "jira",
    config: {
      siteUrl: "https://altitude.atlassian.net",
      projectKey: "OPS",
      issueType: "Task",
      resolveTransition: "Done",
      email: "ops@altitude.demo",
    },
    secrets: sealSecrets({ apiToken: `demo-not-real-${"j".repeat(20)}` }),
    destination: "Jira OPS on altitude.atlassian.net",
    events: ["incident"],
    enabled: true,
  });
  const [matrixChannel] = await db
    .insert(notificationChannels)
    .values({
      organizationId,
      name: "Matrix - Infra room",
      provider: "matrix",
      config: {
        homeserverUrl: "https://matrix.altitude.demo",
        roomId: "!infra:altitude.demo",
      },
      secrets: sealSecrets({
        accessToken: `syt_demo_not_real_${"m".repeat(16)}`,
      }),
      destination: "Matrix room !infra:altitude.demo",
      events: ["monitor", "incident"],
      enabled: true,
    })
    .returning();
  // Named for what it is on every surface, including this one: a bridge
  // to a server the customer runs, not a Vigil integration with the
  // services behind it, and not counted among the native providers.
  await db.insert(notificationChannels).values({
    organizationId,
    name: "Apprise bridge - our own server",
    provider: "apprise",
    config: {
      serverUrl: "https://apprise.altitude.demo",
      configKey: "ops",
    },
    secrets: "",
    destination: "Apprise ops on apprise.altitude.demo",
    events: ["monitor"],
    enabled: true,
  });
  await db.insert(notificationChannels).values({
    organizationId,
    name: "Twilio - Duty phone",
    provider: "twilio",
    config: {
      accountSid: `AC${"0".repeat(32)}`,
      to: "+15550000042",
      from: "+15550000001",
    },
    secrets: sealSecrets({ authToken: `demo-not-real-${"t".repeat(16)}` }),
    destination: "SMS to +15550000042",
    events: ["incident"],
    enabled: false,
  });
  // A SECOND Slack channel, scoped to one monitor. Two instances of one
  // provider with different routing is the configuration the old cap
  // and the old single-endpoint model could not express, so the demo
  // shows it rather than describing it.
  const [slackClientChannel] = await db
    .insert(notificationChannels)
    .values({
      organizationId,
      name: "Slack - Checkout team",
      provider: "slack",
      config: {},
      secrets: sealSecrets({
        webhookUrl:
          "https://hooks.slack.com/services/T0DEMO/B0CHECKOUT/demo-not-real",
      }),
      destination: "hooks.slack.com/[redacted]",
      // Scope is stored, not inferred from the rows below: those cascade
      // when a monitor is deleted, and a channel that lost its targets
      // must go quiet rather than inherit the whole workspace.
      scopedToMonitors: true,
      events: ["monitor", "incident"],
      enabled: true,
    })
    .returning();
  await db.insert(notificationChannelMonitors).values({
    channelId: slackClientChannel!.id,
    monitorId: monitorIds["Checkout Service"]!,
  });
  await db.insert(notificationChannels).values({
    organizationId,
    name: "Webhook - Statuspage sync",
    provider: "webhook",
    config: { url: "https://ops.altitude.demo/hooks/vigil" },
    secrets: sealSecrets({ secret: `whsec_${"d".repeat(48)}` }),
    destination: "ops.altitude.demo/hooks/vigil",
    events: ["incident"],
    enabled: true,
  });
  const [telegramChannel] = await db
    .insert(notificationChannels)
    .values({
      organizationId,
      name: "Telegram - On-call",
      provider: "telegram",
      config: { chatId: "-1002000000042" },
      secrets: sealSecrets({
        botToken: "7000000000:demo-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      destination: "Telegram chat -1002000000042",
      events: [
        "incident",
      ],
      enabled: true,
    })
    .returning();
  await db.insert(notificationChannels).values({
    organizationId,
    name: "ntfy - Phone push",
    provider: "ntfy",
    config: { serverUrl: "https://ntfy.sh", topic: "altitude-demo-alerts" },
    secrets: "",
    destination: "ntfy topic altitude-demo-alerts at ntfy.sh",
    events: ["expiry"],
    enabled: false,
  });
  await db.insert(notificationOutbox).values([
    {
      organizationId,
      idempotencyKey: `demo:checkout:monitor.down:${slackChannel!.id}`,
      channel: "channel",
      channelId: slackChannel!.id,
      provider: "slack",
      event: "monitor.down",
      destination: "hooks.slack.com/[redacted]",
      payload: {
        kind: "channel",
        event: "monitor.down",
        title: "🔴 Monitor down - Checkout Service",
        text: "Checkout Service is down",
        severity: "critical",
        organizationId,
        data: {},
        timestamp: new Date(now - 2 * HOUR).toISOString(),
      },
      state: "delivered",
      attempts: 1,
      deliveredAt: new Date(now - 2 * HOUR + 900),
      createdAt: new Date(now - 2 * HOUR),
    },
    {
      organizationId,
      idempotencyKey: `demo:checkout:incident.opened:${telegramChannel!.id}`,
      channel: "channel",
      channelId: telegramChannel!.id,
      provider: "telegram",
      event: "incident.opened",
      destination: "Telegram chat -1002000000042",
      payload: {
        kind: "channel",
        event: "incident.opened",
        title: "🔴 Incident opened - Checkout Service is down",
        text: "Severity: critical.",
        severity: "critical",
        organizationId,
        data: {},
        timestamp: new Date(now - 2 * HOUR).toISOString(),
      },
      state: "delivered",
      attempts: 1,
      providerMessageId: "482",
      deliveredAt: new Date(now - 2 * HOUR + 1400),
      createdAt: new Date(now - 2 * HOUR),
    },
    {
      organizationId,
      idempotencyKey: `demo:checkout:monitor.down:${pagerdutyChannel!.id}`,
      channel: "channel",
      channelId: pagerdutyChannel!.id,
      provider: "pagerduty",
      event: "monitor.down",
      destination: "PagerDuty service (US)",
      payload: {
        kind: "channel",
        event: "monitor.down",
        title: "🔴 Monitor down - Checkout Service",
        text: "Checkout Service is down",
        severity: "critical",
        organizationId,
        data: {},
        timestamp: new Date(now - 2 * HOUR).toISOString(),
      },
      state: "delivered",
      attempts: 1,
      // PagerDuty's receipt is the dedup key, which is what makes the
      // recovery close this alert rather than open a second one.
      providerMessageId: `vigil/${organizationId}/incident/checkout-demo`,
      deliveredAt: new Date(now - 2 * HOUR + 700),
      createdAt: new Date(now - 2 * HOUR),
    },
    {
      organizationId,
      idempotencyKey: `demo:api:monitor.up:${slackChannel!.id}`,
      channel: "channel",
      channelId: slackChannel!.id,
      provider: "slack",
      event: "monitor.up",
      destination: "hooks.slack.com/[redacted]",
      payload: {
        kind: "channel",
        event: "monitor.up",
        title: "🟢 Monitor recovered - Public API",
        text: "Down for 12m.",
        severity: "ok",
        organizationId,
        data: {},
        timestamp: new Date(now - 26 * HOUR).toISOString(),
      },
      state: "delivered",
      attempts: 2,
      lastError: "503: upstream connect error",
      deliveredAt: new Date(now - 26 * HOUR + 65_000),
      createdAt: new Date(now - 26 * HOUR),
    },
    {
      organizationId,
      idempotencyKey: `demo:cert:monitor.down:${telegramChannel!.id}`,
      channel: "channel",
      channelId: telegramChannel!.id,
      provider: "telegram",
      event: "incident.resolved",
      destination: "Telegram chat -1002000000042",
      payload: {
        kind: "channel",
        event: "incident.resolved",
        title: "🟢 Incident resolved - Public API latency",
        text: "Down for 12m.",
        severity: "ok",
        organizationId,
        data: {},
        timestamp: new Date(now - 26 * HOUR).toISOString(),
      },
      state: "failed",
      attempts: 6,
      lastError: "429: Too Many Requests: retry after 31",
      createdAt: new Date(now - 26 * HOUR),
    },
  ]);

  // The states 1.18.0 separated, so the ledger screenshot shows the
  // distinction rather than describing it: one message the provider
  // rejected outright, one that ran out of attempts against a provider
  // that was down, and one still going round with hours of budget left.
  const [deadLettered] = await db
    .insert(notificationOutbox)
    .values({
      organizationId,
      idempotencyKey: `demo:api:monitor.down:deadletter`,
      channel: "channel",
      channelId: matrixChannel!.id,
      provider: "matrix",
      event: "monitor.down",
      destination: "Matrix room !infra:altitude.demo",
      payload: {
        kind: "channel",
        event: "monitor.down",
        title: "🔴 Monitor down - Public API",
        text: "Public API is not responding.",
        severity: "critical",
        organizationId,
        data: {},
        timestamp: new Date(now - 9 * HOUR).toISOString(),
      },
      state: "dead_letter",
      attempts: 20,
      lastError: "503: matrix.altitude.demo returned Service Unavailable",
      createdAt: new Date(now - 9 * HOUR),
      expiresAt: new Date(now - 3 * HOUR),
    })
    .returning();

  const [retrying] = await db
    .insert(notificationOutbox)
    .values({
      organizationId,
      idempotencyKey: `demo:cert:expiry:retrying`,
      channel: "channel",
      channelId: pagerdutyChannel!.id,
      provider: "pagerduty",
      event: "monitor.down",
      destination: "PagerDuty service (US)",
      payload: {
        kind: "channel",
        event: "monitor.down",
        title: "🔴 Monitor down - Billing webhook",
        text: "Billing webhook is not responding.",
        severity: "critical",
        organizationId,
        data: {},
        timestamp: new Date(now - 40 * MINUTE).toISOString(),
      },
      state: "queued",
      attempts: 7,
      lastError: "503: events.pagerduty.com returned Service Unavailable",
      nextAttemptAt: new Date(now + 4 * MINUTE),
      createdAt: new Date(now - 40 * MINUTE),
      expiresAt: new Date(now + 5 * HOUR),
    })
    .returning();

  // The evidence behind them. Written per attempt, never overwritten,
  // which is what makes the timeline in the app worth opening - and one
  // attempt with no answer, because that is the honest shape of a
  // worker that died mid-flight.
  await db.insert(notificationAttempts).values([
    ...Array.from({ length: 20 }, (_, i) => ({
      outboxId: deadLettered!.id,
      organizationId,
      attempt: i + 1,
      fence: i + 1,
      outcome: (i === 11 ? "unknown" : "retryable") as "unknown" | "retryable",
      httpStatus: i === 11 ? null : 503,
      error:
        i === 11
          ? "the worker holding this attempt never reported an outcome"
          : "503: matrix.altitude.demo returned Service Unavailable",
      startedAt: new Date(now - 9 * HOUR + i * 25 * MINUTE),
      finishedAt: new Date(now - 9 * HOUR + i * 25 * MINUTE + 8_000),
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      outboxId: retrying!.id,
      organizationId,
      attempt: i + 1,
      fence: i + 1,
      outcome: "retryable" as const,
      httpStatus: 503,
      error: "503: events.pagerduty.com returned Service Unavailable",
      startedAt: new Date(now - 40 * MINUTE + i * 5 * MINUTE),
      finishedAt: new Date(now - 40 * MINUTE + i * 5 * MINUTE + 1_200),
      nextAttemptAt: new Date(now - 40 * MINUTE + (i + 1) * 5 * MINUTE),
    })),
  ]);

  console.log(`
Demo tenant ready, organization "${DEMO_ORG.name}" (${DEMO_ORG.slug})

Sign in with (password: ${DEMO_PASSWORD}):
  owner      ${DEMO_USERS.owner.email}
  admin      ${DEMO_USERS.admin.email}
  responder  ${DEMO_USERS.responder.email}
  viewer     ${DEMO_USERS.viewer.email}   (used by /api/demo in DEMO_MODE)

Public status page: /status/${DEMO_ORG.slug}
`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
