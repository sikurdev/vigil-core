# Deployment guide

Vigil deploys as **two processes and one database**: the Next.js app,
the worker, and PostgreSQL 18+. Nothing else is required.

Two more containers exist and neither is part of that install. Deploy the
**synthetics runner** only if you run browser journeys (§4 below), and
**remote probe agents** only if you want checks executed from machines
other than the one Vigil runs on (`docs/REMOTE-PROBES.md`).
Every other feature in the product (maintenance windows, alert routing,
objectives, runbooks, operations tasks) is the same two processes doing
more work on the same queue, and needs no deployment change at all.

## 1. Docker Compose (single host)

The included [docker-compose.yml](../docker-compose.yml) is
production-shaped: Postgres with a persistent volume, a one-shot
`migrate` service, the standalone app image, and the worker image.

```bash
./vigilctl install
```

That is the whole install. It validates Docker, writes a `.env` with
generated secrets (and preserves any you already set), builds the
images, runs the migrations, starts the app and the worker, waits until
the app really answers `/api/ready` and the worker really schedules,
and prints the endpoint. Running it again when nothing needs doing
exits 10 and changes nothing, so it is also the way to repair an install
that was interrupted.

The same CLI owns the rest of the lifecycle: `doctor`, `backup`,
`restore`, `update --to <ref>` and `rollback`. See
[VIGILCTL.md](VIGILCTL.md) for what each one refuses and why.

By hand, which is still supported and still what vigilctl runs:

```bash
# .env next to docker-compose.yml
BETTER_AUTH_SECRET=<openssl rand -base64 32>
APP_URL=https://vigil.yourdomain.com
POSTGRES_PASSWORD=<strong password>

docker compose up --build -d
```

Put a TLS-terminating reverse proxy in front of port 3000 (Caddy shown;
nginx/Traefik equivalent):

```
vigil.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Note that the compose file publishes `3000` on every interface, so the
proxy is where TLS is added rather than something the app is hidden
behind. On a host you do not want Vigil reachable on directly, bind the
published port to loopback and let the proxy do the reaching.

A host with no public IP at all, behind NAT or a firewall you do not
administer, has a third option: a reverse tunnel, which needs no
inbound port and no forwarded router port.
[LOCALTONET.md](LOCALTONET.md) is a worked example with Localtonet,
including what you trade away by terminating TLS at somebody else's
edge.

### Upgrading a running stack

```bash
./vigilctl update --to v1.27.0
```

Preflight, a verified backup, the checkout, the build, the migrations,
the restart, then real health. It never picks a version for you, and a
failed update prints `./vigilctl rollback`, which puts the checkout and
the database back together. Migrations are forward-only, so the rollback
restores the pre-update dump rather than pretending to un-apply
anything: [VIGILCTL.md](VIGILCTL.md) has the detail.

By hand:

```bash
git pull
docker compose build
docker compose up -d      # migrate runs first, then app/worker restart
```

## 2. Managed platforms

- **App (Next.js)**: Can be deployed to **Vercel** (Serverless) or any container platform (Render, Fly.io, Railway). If deploying to Vercel, simply connect your repository and configure the environment variables.
- **Worker (Background checks)**: Because Vercel is serverless, it does not support long-running processes required for queue polling. You must run the worker process on a container/server platform. **Fly.io** (free tier supports small persistent VMs) or paid background workers on **Render** (starts at $7/mo) or **Railway** are ideal. Configure it to build using `npm ci` and start using `npm run worker` (or target the `worker` stage in the Dockerfile).
- **Database**: Any managed PostgreSQL **18+** database (required for native `uuidv7()`). **Neon.tech** is highly recommended and offers a free tier.
- **Migrations**: Run `npx drizzle-kit migrate` as a pre-deploy or release step, or run it locally pointing to your production database before launching.

### Hybrid Setup Example (Vercel + Neon + Fly.io/Render Worker)

1. **Database:** Set up a database on Neon, copy the connection string.
2. **Frontend (Vercel):** Connect your GitHub repo, set the Framework Preset to Next.js. Add `DATABASE_URL` (Neon), `BETTER_AUTH_SECRET` (generate one), and `APP_URL` (your deployment URL) to the Environment Variables.
3. **Worker:** Create a new background worker/VM on Fly.io (free) or Render (paid). Link the same repository. Add the same `DATABASE_URL`, `BETTER_AUTH_SECRET` and `APP_URL` environment variables (the worker embeds `APP_URL` in incident notification links). Set the Start Command to `npm run worker`.
4. **Communication:** Both processes will securely coordinate through the Neon database using `pg-boss`. No Redis or open network ports between the frontend and worker are needed.

## 3. Bare metal / VM without Docker

```bash
npm ci
npm run build
npm run db:migrate

# standalone output does not include static assets, copy them in once per build:
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# process manager of your choice (systemd/pm2):
node .next/standalone/server.js     # app, PORT=3000
npm run worker                      # worker
```

Running more than one worker is supported and needs no configuration:
Postgres arbitrates who fires the cron, who runs the scheduler tick and
who takes each check, so a second replica is capacity rather than a
coordination problem. Give each one a distinct `VIGIL_ACTOR_NAME` (its
ledger identity; sharing one means sharing a chain and contending on its
sequence). `MONITOR_SCHEDULER_BATCH` bounds how many due monitors one
tick enqueues; the default of 5000 suits fleets far larger than most
installations run.

## 4. The two optional planes

Neither is in `docker compose up`. Both are commercial, and both are
removed from Vigil Core by name.

**The synthetics runner**, for `synthetic-browser` journeys only. It is a
Compose overlay, and the worker and the runner must present the same
token:

```bash
echo "SYNTHETICS_RUNNER_TOKEN=$(openssl rand -base64 32)" >> .env
docker compose -f docker-compose.yml -f docker-compose.synthetics.yml up -d
```

The overlay puts the runner on a network of its own and publishes no
port, which is the point: what is reachable is a browser that renders
whatever it is told to. Vigil refuses the unsafe deployments rather than
warning about them: beyond loopback a token is required, and on a public
address https as well. It checks that before it builds a request
body, so a journey's secrets are never put on a connection that would
have been refused. Sizing, readiness, running more than one, and the
`SYNTHETIC_CONCURRENCY` / `SYNTHETIC_QUEUE_MAX_DEPTH` settings that stop
browser journeys starving your HTTP monitors are in
`docs/SYNTHETICS.md` §8, which is the canonical page for all of
it. API journeys need none of this: they execute in the worker through
the same egress guard every other HTTP check uses.

**Remote probe agents**, for checks executed somewhere other than the
host Vigil runs on. A probe is a headless container that connects
outbound only, so there is no inbound port and nothing to open in a
firewall. Enrolment, rotation, quorum, firewall rules and mixed-version
fleets are in `docs/REMOTE-PROBES.md`. Remote rounds need an
interval of 20 seconds or more.

## Environment

See [sample.env.production](../sample.env.production) for the full
annotated template. Required: `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`APP_URL`.

## Resource envelope

Measured on the 1.26.0 release over hour-long soaks, at idle and with
fleets of 100, 500 and 1,000 monitors on one worker (the raw artifacts
ship with the commercial edition):

- **App (Next.js)**: roughly 115 MB RSS, flat under load.
- **Worker**: roughly 180 MB as a process tree at idle, 200 MB at 100
  monitors, 280 MB at 500 to 1,000. Post-settle memory slopes were
  negative on every plane over hour-long windows: no leak.
- **PostgreSQL**: 140 to 210 MB of private memory plus shared buffers
  and your data. Job-queue retention is bounded (finished queue rows
  are deleted after an hour, swept every ten minutes), so the queue
  does not grow the database at steady state.

2 GB of RAM fits a single-host Compose install of all services plus
PostgreSQL with headroom. Disk is dominated by check history, bounded
by the 90-day retention job.

## Operational notes

- **Health**: two probes, and they answer different questions.

  - `GET /api/live`: 200 whenever the process can serve a request. It
    touches no database and runs no migration. Point a **restart**
    policy at this one (Kubernetes `livenessProbe`), and nothing else:
    it answers yes while the database is empty.
  - `GET /api/ready`: 200 only when Postgres is reachable **and** every
    migration this build ships is recorded as applied. 503 for an
    unreachable server, an empty database, and a database left part-way
    through a migration run. Point **traffic** at this one: load
    balancers, `readinessProbe`, and anything that gates a deploy.

  `/api/ready` asks on a small pool of its own, never the application's:
  at most two connections, each destroyed if it has not been established
  in 1.5 seconds, with the whole probe answering inside 3. The bound is
  not decoration. A database that accepts a connection and then stops
  answering never releases one, so a probe borrowing the application's
  pool would spend it in ten ticks and take the application down with it.
  Budget two extra Postgres connections per web replica.

  `GET /api/health` is kept as an alias for `/api/ready`, because that
  is what every healthcheck and external monitor pointed at it since 1.0
  was already using it for. It has the same body and the same status
  codes; use the named endpoints in anything new. The compose file
  points the app's container healthcheck at `/api/ready`.

  All three are unauthenticated and say nothing but `{"status":"ok"}` or
  `{"status":"unavailable"}`: no version, no schema state, no topology.
  Which of the three readiness failures it was goes to the app log, not
  to the caller.

  The worker logs `worker started` on boot and exits non-zero on fatal
  errors, wire it into your restart policy.

- **Logs**: both processes emit structured JSON (pino) on stdout. Set
  `LOG_LEVEL=debug` temporarily for check-level detail.
- **Backups**: one `pg_dump` covers everything, see
  [Backups & restore](#backups--restore) below for the procedure.
- **Email**: set `RESEND_API_KEY` (and `EMAIL_FROM`, a Resend-verified
  sender) on both the app and the worker to deliver incident emails via
  Resend; without a key they fall back to structured logs. A future
  SMTP/SES provider is another `EmailTransport` in
  `src/modules/notifications`.
- **Webhooks**: configured per organization under
  _Settings → Notifications_, no env needed. Receivers verify the
  `X-Vigil-Signature` header (HMAC-SHA-256 of the raw body). See
  ARCHITECTURE.md §8 for the payload and event list.
- **On-call & escalation**: schedules and escalation policies are
  configured under _Settings → Escalation_; attach a policy to a monitor
  on its form. Email steps need no extra config.
  Members set their own escalation phone (E.164) under _Settings →
  General → Your profile_.
- **Status-page subscriptions**: visitors to a _public_ status page can
  subscribe by email (double opt-in) to incident open/update/resolve
  notifications. Delivery reuses the email transport above, no separate
  config; without `RESEND_API_KEY` the confirmation and notification
  emails are written to the logs like every other email. Operators see
  subscriber counts under _Settings → Status page_.
- **Automatic recovery**: configured per monitor on its detail page.
  Point the recovery endpoint at something inside your infrastructure
  that fixes the failure, a restart hook, a runbook trigger; a
  dependency-free starter lives in `examples/recovery-receiver.mjs`
  (verify the signature, run one command), with ready-made Docker,
  Compose, Kubernetes and systemd templates in
  `examples/recovery-templates.md`. The worker verifies the
  failure before triggering and verifies the target again afterwards;
  attempts are bounded per incident, capped per day (restart-loop
  guard), and recorded on the incident timeline. With _hold alerts
  while recovering_ enabled, a verified recovery pages nobody; a
  failed or overdue one pages immediately.
- **Planned work, routing, objectives, runbooks and tasks** need no
  deployment configuration. They are configured in the product and run
  on the worker's existing queues: `docs/MAINTENANCE.md`,
  `docs/ALERT-ROUTING.md`, `docs/SLOS.md`,
  `docs/RUNBOOKS.md`, `docs/TASKS.md`.
- **Scaling**: app and worker are independently horizontal; the queue
  serializes per-monitor work, and there is no leader election to
  operate. See ARCHITECTURE.md §9 for the pressure → response table and
  `docs/SCALING.md` for the measured numbers behind it.

## Backups & restore

All state lives in Postgres: domain data, auth, the audit trail,
status-page subscribers and the job queue. The `pgboss` schema is
disposable (it rebuilds on worker start), so a single dump is a complete
backup. The only other thing to keep is your `.env`: **the same
`BETTER_AUTH_SECRET` must survive a restore**, because sessions and
status-page subscription tokens are signed with it; restoring data under
a new secret signs everyone out and invalidates pending
confirm/unsubscribe links.

**Back up** (compose deployment; adjust user/db if you changed them):

```bash
docker compose exec postgres pg_dump -U vigil -Fc vigil > vigil-$(date +%F).dump
```

Run it from cron at whatever cadence your incident history is worth.
Daily is typical. Keep dumps off the host that runs Vigil.

**Restore** onto a fresh stack:

```bash
docker compose up -d postgres          # just the database
docker compose exec -T postgres pg_restore -U vigil -d vigil \
  --clean --if-exists --no-owner < vigil-YYYY-MM-DD.dump
docker compose up -d                   # migrate no-ops, app + worker start
```

The migrate service compares the restored journal against the shipped
migrations, so restoring an older dump into a newer checkout applies the
missing migrations automatically.

**Disaster recovery** is those two steps on a new host: copy the source
checkout and your `.env`, restore the latest dump, `docker compose up -d`.
Nothing else holds state, no volumes to move besides Postgres, no local
files the app writes.

## Troubleshooting

Symptom → cause → fix, from real deployments:

- **App container exits immediately, logs show `getaddrinfo` /
  `EAI_AGAIN`**. Next's standalone server binds to `$HOSTNAME`, which
  Docker sets to the container id. The shipped image already pins
  `HOSTNAME=0.0.0.0`; if you run the standalone build outside this image,
  set that yourself.
- **`relation "..." does not exist`**: migrations haven't run. Compose
  runs them via the one-shot `migrate` service; on bare metal run
  `npm run db:migrate` before starting.
- **No emails arrive**: without `RESEND_API_KEY` every email is written
  to the logs instead (grep for `email`); that's the designed fallback,
  not a failure. With a key set: `EMAIL_FROM` must be a Resend-verified
  sender, the default `onboarding@resend.dev` only delivers to the
  Resend account owner.
- **Monitor against an internal host fails instantly**. Monitor URLs
  are SSRF-guarded: private and loopback addresses are refused by
  default. `ALLOW_PRIVATE_MONITOR_TARGETS=true` lifts this for dev only.
  Recovery endpoints are the deliberate exception (your own restart
  hooks are usually internal), see docs/security.
- **Sign-up disabled / every mutation rejected**: `DEMO_MODE=true` is
  set. That's the read-only public-demo switch (docs/DEMO.md), not a
  broken install.
- **Browser sign-in rejected while `curl` works**: `APP_URL` must equal
  the origin users type into the browser (it's the auth trusted origin).
  A port or scheme mismatch fails exactly this way.


- **A recovery attempt shows `running` forever**: the worker was
  interrupted mid-attempt (recovery jobs deliberately never retry). The
  nightly retention job closes attempts stuck over an hour as failed;
  no action needed beyond restarting the worker.
- **Status page shows slightly stale data**: public pages are cached
  for ~60 s so an outage traffic spike never reaches Postgres. That lag
  is by design.
