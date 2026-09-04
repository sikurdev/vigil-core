# Publishing Vigil through a Localtonet tunnel

For the host that has no public IP: a home server, a NAT'd VM, a
laptop, a machine behind a firewall you do not administer. Vigil runs
there, listens on nothing the internet can route to, and reaches the
internet the only way that host can, which is outbound.

This is a deployment recipe, not a feature of Vigil. Vigil does not know
it is behind a tunnel and has no Localtonet integration. What follows is
Compose plumbing, one environment variable, and the two places where
"the origin is not where the browser thinks it is" actually bites.

Read [DEPLOYMENT.md](DEPLOYMENT.md) first. This page changes exactly two
things about the single-host Compose install described there: where the
app listens, and what `APP_URL` says.

## 1. What you are trading

A reverse tunnel moves the reachability problem rather than solving it.
Be clear about what moves where.

**What you stop needing:** a public IP, a port forward on a router you
may not own, a firewall exception, a dynamic DNS record, and a
certificate you renew. Nothing accepts inbound connections on your host.

**What you start trusting:** Localtonet terminates TLS at its edge for
HTTP/s tunnels and forwards plaintext HTTP to your service
([localtonet.com/documents/tls](https://localtonet.com/documents/tls)).
Every request and response to your monitoring system, including the
session cookie of whoever is logged in, is readable at that edge. The
tunnel definition itself lives in their dashboard, not in your
repository: it says which local IP and port to forward to
([localtonet.com/documents/https](https://localtonet.com/documents/https)),
and it is changed by whoever can log in there.

**What that rules out.** If the requirement is that nobody between the
browser and your host can read the traffic, an HTTP/s tunnel does not
meet it and no setting makes it. Localtonet's TLS tunnel type is
passthrough, so your service presents its own certificate and the edge
cannot read the stream, but Vigil serves plain HTTP and has no
certificate of its own, so reaching that arrangement means putting a
TLS-terminating proxy of your own between the tunnel and Vigil. That is
a different guide and a different set of trade-offs. Section 11 says
what it would take.

Vigil is a monitoring system, which means the interesting thing about it
is not the data at rest but the fact that a login to it is a login to
everything it can reach. Webhook notification channels post to whatever
URL the logged-in operator configures, and
`ALLOW_PRIVATE_WEBHOOK_TARGETS` defaults to true for the honest reason
`src/lib/env.ts` gives: a self-hosted install routinely posts to a
receiver on its own private network. Decide whether an edge that can
read a session cookie is acceptable for that before, not after.

## 2. Shape of the install

```
  browser ──https──▶ Localtonet edge ──▶ agent ──http──▶ 172.31.243.2:3000
                     (TLS ends here)     (outbound          │
                                          only)      pinned in the
                                                     overlay
                                                            │
                                                    ┌───────┴─────────┐
                                                    │ vigil_default   │
                                                    │ postgres, worker│
                                                    └─────────────────┘
```

Two Compose networks. `vigil_default` is the stock stack: app, worker,
Postgres. `vigil_edge` holds the app and the agent and nothing else, so
the agent has no route to your database even though the two run on one
host. The agent's only inbound-facing job is to hold an outbound
connection open; it accepts nothing.

No host port is published at all. Not `0.0.0.0:3000`, not
`127.0.0.1:3000`. `scripts/localtonet-verify.sh` checks it, and treats
a non-loopback bind on 3000 as a failure rather than a convenience.

## 3. Before you start: get a token

You need a Localtonet account and an AuthToken. Vigil cannot create one
and neither can this guide.

1. Sign in at [localtonet.com](https://localtonet.com).
2. Dashboard, then **My Tokens**. Copy an existing token or create one.
3. Keep it out of your shell history and out of this repository. Step 4
   puts it in `.env`, which is gitignored.

Treat the token as the credential it is: anything holding it can
authenticate as your agent and, through the dashboard's tunnel
definitions, decide which local address that agent forwards to.

## 4. Configure

Append to the `.env` beside `docker-compose.yml`. It is gitignored, and
that is the only reason this is safe:

```bash
cat >> .env <<'EOF'
LOCALTONET_AUTHTOKEN=paste-your-token-here
EOF
```

`APP_URL` comes later, in step 7, because you do not know the hostname
until the tunnel exists.

`LOCALTONET_AUTHTOKEN` is the only new variable. `APP_URL` already
exists in `.env.example`; this deployment changes what it is set to.

## 5. Start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml up -d
```

Order matters and Compose enforces it: Postgres becomes healthy,
`migrate` runs once and exits, the app and worker start, and the agent
waits for the app's healthcheck before it starts. That last dependency
is startup ordering only. It does not stop the agent later if the app
becomes unhealthy, which is section 9's first failure mode.

The overlay must be named on every subsequent command too. Compose
composes the stack out of the files you give it, so
`docker compose ps` without both `-f` flags describes a different stack
than the one running.

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml ps
```

## 6. Create the tunnel

The agent takes no tunnel configuration. Its only documented argument is
`--authtoken` ([localtonet.com/documents/docker](https://localtonet.com/documents/docker)),
and the tunnel is defined in the dashboard instead:

1. Dashboard, **HTTP/s tunnel**.
2. **Process Type**: Random Sub Domain to start. Custom Sub Domain or a
   custom domain once it works.
3. **AuthToken**: the one the agent is running with.
4. **Server**: whichever region you want the edge in.
5. **IP**: `172.31.243.2`. **Port**: `3000`.
6. Start the tunnel.

Step 5 is the one people get wrong, twice over.

**The field means IP, literally.** It will not take a hostname. Entering
the Compose service name `app` returns `Please enter valid IP Address.`
and the tunnel is not created. Docker's embedded DNS does resolve `app`
for the agent, and it makes no difference: the dashboard refuses the
name before the agent is ever asked. This is why
`docker-compose.localtonet.yml` pins the app to `172.31.243.2` on the
`edge` network rather than letting Docker assign an address.

**The address is resolved by the agent, in its own container, on its own
network namespace.** `127.0.0.1` there is the agent itself and forwards
to nothing. `172.31.243.2` is the app, on the network the two share.

If `172.31.243.0/29` collides with something your host already routes,
change both the `subnet` and the `ipv4_address` in the overlay and enter
the address you chose here instead. Check with `ip route` first; a
collision fails in a way that looks like a broken tunnel.

The dashboard shows the public hostname once the tunnel starts. It is
the one secret-adjacent value this setup produces that is not a
credential and still should not be pasted into a public issue: it is a
routable address for your monitoring system.

## 7. Tell Vigil its own name

Vigil derives its canonical origin from `APP_URL` and nothing else. Two
places in the code care, and both fail in ways that do not say
"APP_URL":

- `src/lib/auth.ts` sets both `baseURL` and `trustedOrigins` from it.
  A sign-in attempt from an origin that is not in that list is rejected.
- Everything that builds a link someone else will click reads it:
  incident links in notifications
  (`src/modules/notifications/incident-payload.ts`), status-page
  confirmation and unsubscribe links
  (`src/app/status/[slug]/actions.ts`), the push-monitor URL shown in
  the UI (`src/modules/monitors/heartbeat.ts`), the public status-page
  URL (`src/app/(app)/status-page/page.tsx`), and organization
  invitation links (`src/lib/auth.ts`).

So:

```bash
echo 'APP_URL=https://your-subdomain.localto.net' >> .env
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml up -d
```

Both the app and the worker read it, and `up -d` restarts what changed.
A worker still holding the old value keeps sending notifications whose
links go nowhere, and nothing logs a complaint about it.

Pick one origin and use it. `APP_URL` is a single value, not a list: an
install that answers on both `https://x.localto.net` and
`http://localhost:3000` has to choose which of the two can log in.

Set correctly, that is all this deployment needs from you. Signing in
through the tunnel, the authenticated dashboard, and the session cookie
surviving the edge were all confirmed on a real install with nothing set
beyond `APP_URL` and `LOCALTONET_AUTHTOKEN`. If sign-in fails, the cause
is almost always this value disagreeing with the address bar; section 14
has the rest.

## 8. Health checks

Local, inside the stack. There is no host port, so this goes through
`docker compose exec` rather than curl on the host:

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml \
  exec app node -e \
  "fetch('http://localhost:3000/api/ready').then(r=>r.json().then(b=>console.log(r.status,JSON.stringify(b))))"
```

`GET /api/ready` returns `200 {"status":"ok"}` only when Postgres is
reachable and every migration packaged with this build is recorded as
applied. It returns `503 {"status":"unavailable"}` for an unreachable,
empty, or partially migrated database (`src/app/api/ready/route.ts`). It
never runs migrations. It says nothing about the tunnel, and it cannot:
the app has no idea one exists.

`GET /api/live` is the process-only liveness probe for restart policies.
`GET /api/health` remains a compatibility alias for `/api/ready`; use the
named endpoints in new checks.

Public, from anywhere. The header is not optional on a free account:

```bash
curl -sS -H 'localtonet-skip-warning: 1' \
  -o /dev/null -w '%{http_code} %{ssl_verify_result} %{time_total}\n' \
  https://your-subdomain.localto.net/api/ready
```

**Without that header a free Localtonet account answers every request
with its own interstitial** ("You are about to navigate to ...") and a
status of **200**. Not a redirect, not a 4xx: a 200 carrying somebody
else's HTML. The page says so itself, under "Are you the site
developer?": send a `localtonet-skip-warning` request header of any
value, or upgrade to a premium account. Browsers see the page once and
click through; every API client, health check and uptime monitor sees it
on every request, forever, unless it sends the header.

Read that twice if you are about to point a monitor at this URL. A check
that asserts "the connection succeeded and the status was 200" reports a
healthy Vigil while the edge is serving an interstitial and your app
might be off. Assert on the body.

Two different questions, and you want both. The first says Vigil is ready
inside the stack. The second says the same ready application is reachable
through the tunnel. A monitoring system that only answers the first is a
monitoring system you cannot see when you need it.

`scripts/localtonet-verify.sh` runs both plus the port check below.

## 9. Failure modes

Test these before you rely on the install. The numbers below were
measured on one install, on one connection, against one edge region;
treat them as the shape of the answer rather than as your answer, and
re-measure yours.

**The agent stops.** `docker compose ... stop localtonet`. The edge
answers **502** with a "Localtonet Error" HTML page: "An unexpected
error occurred while proxying the request." The first such response came
back in 0.4 s, later ones in about 10 s. Meanwhile Vigil keeps serving
on `172.31.243.2:3000` and `/api/ready` keeps returning 200 inside the
stack. Nothing in Vigil records that it became unreachable, because from
Vigil's side nothing happened.

**The agent comes back.** `docker compose ... start localtonet`.
Measured: **15.2 s** from `start` to the public URL returning Vigil's
own 200. That is the lower bound on how long you are invisible after any
agent restart, and it is the number to compare against
`restart: unless-stopped` doing it for you unattended.

**The app stops.** `docker compose ... stop app`. The agent stays
connected, so the tunnel stays up, and the edge now has nowhere to
forward to. Measured: **HTTP 500 after 27.1 s**, with a "Localtonet
Error" page headed `HostUnreachable`, body `No route to host`, naming
`172.31.243.2:3000` explicitly.

Two details in that sentence do real work. The first is **27 seconds**:
any checker whose timeout is shorter sees a client-side timeout instead
of a 500, and most default to 10 or 30, which straddles it. The same
outage therefore reports as two different failures depending on the
checker. The second is `No route to host` rather than "connection
refused": a stopped container loses its address entirely, so the agent
gets no route rather than a refusal. An app that is running but has
crashed its listener would give you the other error and a different
timing.

**The app comes back.** `docker compose ... start app`. The container
gets `172.31.243.2` back, because the overlay pins it rather than
letting Docker choose, so the tunnel definition needs no change.
Measured: **3.0 s** from `start` to a public 200. Faster than the agent
restart above, which is worth knowing: the slow half of this deployment
is the tunnel, not the application.

The asymmetry is the thing to take away: three of these four are
invisible to the software you installed to notice things. Which leads
to the next section.

## 10. Monitoring the tunnel

You cannot monitor the tunnel through the tunnel. A Vigil monitor
pointed at your own public URL runs in the worker, on the host, and
reaches the edge outbound; it will go DOWN when the tunnel dies, which
is correct, and then it will try to page you through channels that also
leave the host outbound, which mostly still works. But the incident
detail link in that page points at `APP_URL`, which is the URL that just
stopped working.

Localtonet emits webhooks on tunnel and token state changes: a POST with
`{"Id", "ActionDate", "Type", "Status"}` where `Status` is `Connected`
or `Disconnected`
([localtonet.com/documents/webhook](https://localtonet.com/documents/webhook)).
It is tempting to point that at a Vigil push monitor. Do not point it
there directly. Vigil's push endpoint reads status from the **query
string**, not the body: `arrivalFrom()` in
`src/app/api/push/[token]/route.ts` treats anything that is not
`?status=down` as "up". A `Disconnected` webhook posted to
`/api/push/<token>` therefore records a healthy heartbeat, and the
monitor that exists to tell you the tunnel died would report it alive at
the moment it died.

There is also a routing problem underneath the parsing one. Localtonet
delivers that webhook from their infrastructure to a URL, and the only
URL your Vigil has is the one behind the tunnel that just went down.

What works: send the webhook somewhere that is not behind this tunnel,
and check the public URL from somewhere that is not this host. A second
Vigil, a free external checker, a cron job on a different machine.
Anything, as long as it is not standing on the thing it is watching.

## 11. Deployment variants

**Local browser access as well.** Add `- "127.0.0.1:3000:3000"` to the
overlay's `app.ports`, below the `!reset []`. Loopback only. Going back
to `"3000:3000"` puts the app on every interface of the host and undoes
the point of the exercise.

**A different fixed address.** The overlay already pins the app, because
the dashboard requires a literal address and section 6 says so. What is
variable is _which_ address. If `172.31.243.0/29` collides with
something your host routes, change both halves together:

```yaml
services:
  app:
    networks:
      default: null
      edge:
        ipv4_address: 10.83.7.2
networks:
  edge:
    ipam:
      config:
        - subnet: 10.83.7.0/29
```

Then enter the address you chose in the dashboard. Compose refuses an
`ipv4_address` that does not fall inside a subnet you declared, so the
two always move together.

Fixed rather than whatever Compose hands out, because Compose assigns
bridge addresses in start order and a tunnel aimed at yesterday's
address forwards to whatever holds it today. Nothing warns you when that
happens: the tunnel stays up and forwards to the wrong container.

**Agent sharing the app's network namespace.** `network_mode:
"service:app"` on the agent lets the tunnel target `127.0.0.1:3000` and
needs no `edge` network or static address at all. It is tidier and it
costs you the app-restart case: the namespace belongs to the app
container, so restarting the app leaves the agent attached to a
namespace that no longer exists.

**Agent on the host instead of in Compose.** The agent ships as a
binary for Linux and Windows
([linux](https://localtonet.com/documents/linux),
[windows](https://localtonet.com/documents/windows)). Publish the app on
`127.0.0.1:3000` and point the tunnel at `127.0.0.1:3000`. This is the
variant to use when Vigil itself is not in Docker, which is
[DEPLOYMENT.md](DEPLOYMENT.md) section 3.

**End-to-end encryption.** Put a TLS-terminating proxy of your own
between the agent and Vigil, give it a certificate, and use a TLS
tunnel rather than an HTTP/s tunnel so the edge passes the stream
through. You are then running a certificate lifecycle, which is one of
the things the tunnel was supposed to remove, and Localtonet's TLS
tunnel type gives you no HTTP-level features. Worth it only if section 1
ruled out the plaintext edge.

## 12. vigilctl

`./vigilctl` will refuse to drive this install:

```
this project is also running localtonet, which docker-compose.yml does not define.
```

That is `assert_stock_stack` in `scripts/vigilctl/stack.sh` and it is
doing its job. vigilctl runs `docker compose -f docker-compose.yml`,
which does not include the overlay, so `update` would rebuild the app
and the worker and leave the agent alone, out of one command that looks
like it handled the whole stack.

Two ways forward:

- `--allow-customized` on each command. It does not teach vigilctl about
  the overlay; it records that you know.
- Drive the install with `docker compose` and both `-f` flags, and use
  `scripts/backup.sh` and `scripts/restore.sh` directly.

The second is the honest one for a customized stack. See
[VIGILCTL.md](VIGILCTL.md).

## 13. Secret handling

- The token goes in `.env`. `.gitignore` covers `.env*` except
  `.env.example`; confirm with `git check-ignore -v .env`.
- The agent takes it as a command-line argument because that is the only
  form the documentation gives. It is therefore visible in
  `docker inspect vigil-localtonet`, in `docker compose config`, and in
  the host's process table. Anyone with Docker access on this host can
  read it. There is no environment-variable form documented to avoid it.
- `docker compose config` prints a fully resolved file with the token
  in it. Never paste its output anywhere.
- The public hostname is not a credential but it is a routable address
  for your monitoring system. Redact it in issues and screenshots.
- The image `localtonet/localtonet` is referenced without a tag because
  no version tag is documented, so it resolves `latest` and can change
  under you. Pin it to a digest
  (`localtonet/localtonet@sha256:...`) if an unpinned third-party image
  on the same network as your monitoring origin is not acceptable. You
  then pin yourself out of upgrades and have to move the digest by hand.

## 14. Troubleshooting

**Public URL times out, `docker compose ps` shows everything up.** The
tunnel is not started, or it is pointed somewhere the agent cannot
reach. Check the dashboard tunnel state, confirm the target field says
`172.31.243.2`, and confirm the agent can actually reach it from its own
namespace rather than from the host. The agent image carries no `curl`
or `wget`, but it has `bash`, which is enough:

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml \
  exec localtonet bash -c \
  'exec 3<>/dev/tcp/172.31.243.2/3000
   printf "GET /api/ready HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n" >&3
   cat <&3'
```

`HTTP/1.1 200 OK` and `{"status":"ok"}` means the agent's half is fine
and the problem is the dashboard definition. A connection failure means
the agent and the app are not on `edge` together, or the app is not on
the address you pinned. Check that with:

```bash
docker inspect vigil-app-1 \
  --format '{{(index .NetworkSettings.Networks "vigil_edge").IPAddress}}'
```

**Sign-in fails, or a form submits and nothing happens.** `APP_URL` does
not match the origin in the browser's address bar. Section 7.

**"Invalid Server Actions request" or a 403 on a form.** Next.js checks
that the request's origin matches the host it believes it is serving.
Behind a proxy that rewrites `Host` without setting `x-forwarded-host`,
those disagree.

**Localtonet sets it correctly, and this does not happen.** Measured:
server actions and sign-in both work through the tunnel with `APP_URL`
set to the public hostname and nothing else changed. A full browser
sign-in was performed against the public hostname, the authenticated
dashboard rendered, and the session cookie survived the edge. Sending a
deliberately wrong `Origin` produces the failure and names the
mechanism, which is how the header was confirmed present:

```
`x-forwarded-host` header with value `<your-subdomain>.localto.net`
does not match `origin` header with value `evil.example` from a
forwarded Server Actions request. Aborting the action.
```

So if you do hit this, the cause is something between you and the edge,
or an `APP_URL` that does not match the address bar, not Localtonet. The
knob is `experimental.serverActions.allowedOrigins` in `next.config.ts`.
Vigil does not set it and does not need to; reach for it only after
you have ruled out section 7.

**The public URL returns 200 and an unfamiliar page.** A free Localtonet
account serves an interstitial warning to every request that does not
carry a `localtonet-skip-warning` header, with status 200. Section 8.
`scripts/localtonet-verify.sh` sends the header and also asserts on the
body, which is the only reason it can tell this apart from a healthy
install.

**Agent logs nothing useful.** `docker compose ... logs -f localtonet`.
A token problem shows up here and nowhere else. A rejected AuthToken
prints `Wrong Token!  Go ==> https://localtonet.com` on the very first
attempt, about 200 ms after the container starts, and then retries with
no backoff at all: roughly half a million attempts in the first thirty
seconds, measured on one install. The container stays `Up` the whole
time and `docker compose ps` reports nothing wrong, because from
Docker's side nothing is wrong. Stop the agent before you go looking for
the cause, or it keeps hammering Localtonet's authentication endpoint
while you read. `restart: unless-stopped` honours a manual `stop`, but
an agent left in this state comes back with the host.

**Everything works, then stops after a reboot.** The agent has
`restart: unless-stopped`, so it comes back with Docker. The tunnel
itself is dashboard state and comes back with the agent's connection.
If the agent can no longer resolve `app`, check both are still on the
same network: `docker network inspect vigil_edge`.

## 15. Cleanup

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml down
```

Then, and this part is not optional, stop or delete the tunnel in the
dashboard and revoke the AuthToken if the lab was temporary. A stopped
container does not invalidate a token, and a token that is still valid
is a credential you have stopped watching.

To remove the volume as well:

```bash
docker compose -f docker-compose.yml -f docker-compose.localtonet.yml down -v
```

That deletes the database.

## 16. Limitations

- The edge sees plaintext. Section 1.
- The tunnel definition is dashboard state, not repository state. There
  is nothing in this repository that reproduces it, and `up -d` on a new
  host does not recreate it.
- Nothing here is a claim about throughput or availability through the
  tunnel. Neither was measured, and a hop through a third party's edge
  is not free. The only latency figures anywhere in this guide are the
  recovery times in section 9, from one install on one connection
  against one edge region, and they are not a service level.
- Health checks prove the origin is up and the path is open at the
  moment you run them. Neither proves the other was true a minute ago.
- The free-account interstitial in section 8 is a property of the
  account tier, not of this deployment. If you upgrade, the header stops
  being necessary and every example here still works with it.
- A monitor pointed at the public URL has to assert on the response
  body. Status code alone cannot distinguish Vigil from the edge's own
  pages, and section 9 has two different edge pages that are not Vigil.
