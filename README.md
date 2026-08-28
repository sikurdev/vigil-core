<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/vigil-mark.svg">
  <img src="docs/brand/vigil-mark-dark.svg" alt="" width="35" height="56">
</picture>

# Vigil Core

**Self-hosted uptime monitoring, incidents and status pages.** Two
processes and one Postgres: no Redis, no queue broker, no agents to
install.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-brightgreen.svg)](docs/DEPLOYMENT.md)

|                                                                   |                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| ![Dashboard](docs/screenshots/dashboard.png)                      | ![Monitor detail](docs/screenshots/monitor-detail.png)       |
| ![Incident detail](docs/screenshots/incident-detail.png)          | ![Public status page](docs/screenshots/status-page.png)      |
| ![The check-type selector](docs/screenshots/monitor-types.png)    | ![Notification channels](docs/screenshots/notifications.png) |
| ![Delivery history](docs/screenshots/notification-deliveries.png) | ![Uptime Kuma import](docs/screenshots/kuma-import.png)      |
| ![Team roles](docs/screenshots/roles.png)                         | ![Status-page settings](docs/screenshots/branding.png)       |

---

## What it does

- **Forty check types**, behind a registry. The web: HTTP(S), JSON
  query, a real browser engine, TCP/port, UDP, ping (ICMP), DNS records,
  TLS-certificate and domain-registration expiry. Databases: PostgreSQL,
  MySQL / MariaDB, MongoDB, Redis, SQL Server, Oracle, Elasticsearch,
  Memcached. Messaging: MQTT, Kafka, RabbitMQ. Infrastructure: SSH, FTP,
  IMAP, SMTP, LDAP, NTP, SNMP, RADIUS, gRPC, WebSocket, SIP, Docker
  containers, systemd services, Tailscale, Globalping, Steam and GameDig.
  And three that dial nothing: push heartbeats, groups derived from other
  monitors, and a status an operator sets by hand. Adding one is five
  files and no dispatch to edit. Everything but PostgreSQL speaks the
  wire protocol directly, so **not one of them added a dependency**:
  twenty-six types arrived since 1.12.0 and `package.json` is unchanged.
- **Assertions**: expected status, response-time thresholds, body
  contains or does not contain a keyword, DNS record values, days left
  on a certificate. A 200 that serves an error page is caught.
- **Scheduling that adapts.** The interval you set is a baseline: a
  suspicious monitor is probed harder and a steady one backs off. The
  minimum is two seconds on the ordinary scheduler, or 500 ms for
  HTTP, JSON and TCP monitors on the high-frequency plane.
- **Incidents**: opened and resolved by the check loop, with a failure
  window measured in seconds rather than a count of checks. Severity, a
  lifecycle, an append-only timeline, internal-only notes and a
  markdown postmortem.
- **Status pages**: as many as you like, each with its own URL,
  components, 90-day uptime bars and incident history. Public, private
  or password-protected, with double-opt-in email subscribers.
- **Team and roles**: owner, admin, responder, viewer. Viewers are
  read-only at the server boundary, not by hiding a button.
- **Audit trail**: every mutation recorded with actor, target and
  metadata, and a page to read it on.
- **Alerts**: member email plus 25 native provider types behind one
  channel editor and one delivery pipeline, with no cap on how many
  channels you configure. Credentials are stored encrypted, deliveries
  go through a transactional outbox with retries and per-channel rate
  limits, and a delivery history shows provider, event, attempts, final
  status and a redacted error. Signed webhooks keep their HMAC-SHA-256
  signature and versioned payload. Anything not on the list can be
  reached through an Apprise server you run.

No license key, no telemetry, no expiry, and no cap on monitors, users,
organizations' members or retention.

## Quick start

```bash
git clone https://github.com/sikurdev/vigil-core.git
cd vigil-core
./vigilctl install
```

That generates the secrets, builds the images, runs the migrations,
starts the app and the worker and waits until both are really answering,
then prints the endpoint. Docker and bash are all it needs.

The same CLI owns the rest of the lifecycle: `./vigilctl doctor` says
what is wrong without changing anything, `backup` and `restore` use the
dump path with the safety checks around it, and `update --to <ref>` and
`rollback` move the checkout and the database together.
[docs/VIGILCTL.md](docs/VIGILCTL.md) is the reference;
[QUICK_START.md](QUICK_START.md) has the bare-metal path and the
first-monitor walkthrough.

## Container images

Versioned web and worker images are published to GHCR:

```bash
docker pull ghcr.io/sikurdev/vigil-core-web:1.29.0
docker pull ghcr.io/sikurdev/vigil-core-worker:1.29.0
```

For Easypanel, deploy
[`docker-compose.easypanel.yml`](docker-compose.easypanel.yml) as a
Compose service, set its required environment variables, and route the
domain to `web` on port 3000.

## Limitations

Worth knowing before you deploy:

- **Checks run from one host.** A monitor going down means _your Vigil
  host_ could not reach it. The failure window filters blips, but this is
  not multi-region confirmation and never claims to be. Run Vigil outside
  the blast radius of what it watches.
- **25 native provider types, unlimited channels, plus member email**:
  Slack, Discord, Microsoft Teams, Telegram, Google Chat, Mattermost,
  Rocket.Chat, Matrix, Zulip, LINE, PagerDuty, Jira Service Management,
  Pushover, Gotify, ntfy, Pushbullet, Bark, Web Push, Home Assistant,
  Twilio SMS, Twilio WhatsApp, SMTP, Resend, signed webhooks and Amazon
  SNS. Uptime Kuma 2.4.0 ships 94 notification providers, so the gap is
  still real and it is still theirs: a service on their list and not on
  this one routes there today and not here. What narrows it is the
  Apprise bridge - point Vigil at an Apprise server you run and it will
  forward to whatever that server is configured for. That is a bridge,
  not an integration: those services are not implemented, pinned or
  tested here, and none of them is counted in the 25.
- **An import is not a migration of everything.** Every one of Kuma's 31
  selectable monitor types has an equivalent here, but a type having one
  is not a promise that every monitor of that type comes across: Vigil's
  own rules still refuse what they would refuse from the form. Tags and
  maintenance windows have no counterpart in Core and are reported rather
  than carried; notification providers do have one here, but no
  credential is ever read out of a Kuma database, so those are reported
  too and set up again under Settings. `docs/KUMA-IMPORT.md` states both
  numbers and lists every refusal.
- **No scheduled suppression.** Core has no maintenance windows, so a
  planned deploy alerts like an outage. Pause the monitors for the
  duration, or accept the noise.
- **One organization per install.** Fine for a team watching its own
  systems; not built to run many separate clients side by side.

## How this repository is produced

Vigil Core is not maintained by hand. It is generated from the
commercial edition's tree by deleting every file and statement marked
`@edition:ee`. That same script runs in a required job on every push and
pull request there: it strips the tree, then lints, typechecks, tests,
builds, migrates onto an empty Postgres and serves HTTP from what is
left, so Core cannot quietly fall behind. If it did, the build would be
red before the release existed.

Both editions are cut from the same commit and carry the same version
number. **If this repository's version ever trails the commercial one,
the mechanism is broken and you are looking at the evidence.**

History is never rewritten here and releases are never force-pushed, so
a pull request always has somewhere to land.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md): there is no CLA and no copyright
assignment, and it says plainly what Apache-2.0 lets the maintainer do
with your contribution. Security issues go privately to
[SECURITY.md](SECURITY.md), not to the issue tracker.

## The commercial edition

[Vigil](https://vigil-uptime.com) is the same monitor with a set of
things Core does not have. Uptime Kuma has none of them either, with one
exception noted in the list: it has maintenance windows and Core does
not.

- **Isolate.** Many client organizations in one install, each with its
  own status pages and unable to see the others.
- **Rotate.** On-call schedules and escalation ladders that know whose
  turn it is tonight, with acknowledgement stopping the ladder.
- **Reach.** SMS and voice through your own Twilio account.
- **Repair.** Automatic recovery: verify the failure, call a restart
  hook you own with a signed payload, verify it came back, and page a
  human only if it did not.
- **Confirm.** Probe agents you run on your own machines, in the regions
  you choose, with a quorum deciding the verdict. Vigil ships the agent
  and hosts nothing.
- **Suppress and route.** Maintenance windows for planned work, and one
  routing decision about who hears about what, written once and assigned
  to the workspace, a service or a single monitor. Windows are the
  exception above: Uptime Kuma has them and Core does not.
- **Journey.** Multi-step API and browser journeys, `synthetic-api` and
  `synthetic-browser`, the only two the paid edition adds. They need a
  browser container the operator deploys and tables of their own; every
  protocol check type ships in both editions and always will.
- **Promise.** Service level objectives with error budgets and
  burn-rate alerting.
- **Remediate.** Runbooks: typed remediation with immutable published
  versions, approvals and resource leases. And operations tasks, the
  human half of the same engine, for the work a runbook cannot do.
- **See the fleet.** Whether monitoring is actually running, how far
  behind the scheduler is, and what each worker replica's last tick did.

Everything else (every protocol check type, the scheduler, the ledger,
the audit page, subscribers, password-protected pages) is here, free, and
stays here.
[What we commit to, in writing](https://vigil-uptime.com/open-source.html).

## License

[Apache-2.0](LICENSE). Run it, modify it, keep your changes private, run
it for clients, sell it. There is no copyleft obligation. Vigil Core was
AGPL-3.0 through 1.0.1; copies obtained under that license remain
available under it.
