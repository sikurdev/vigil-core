# Security policy

## Reporting a vulnerability

Please report security issues **privately**: do not open a public
issue. Email **s8kur3@gmail.com** (the address on
[the contact page](https://vigil-uptime.com/contact.html)), or use the
support channel on your purchase receipt, with:

- the affected version and component (the app, the worker, the
  synthetics runner or a probe agent),
- steps to reproduce,
- the impact you observed.

You'll receive an acknowledgement, and where a fix is warranted, a
patched release within the version-1 update window.

## Supported versions

Security fixes are published for the current major version (1.x). See
[CHANGELOG.md](CHANGELOG.md) for released versions.

## Hardening your deployment

Vigil is self-hosted, so you own the deployment surface. The essentials:

- Set a strong `BETTER_AUTH_SECRET`: `openssl rand -base64 32`.
- Keep `ALLOW_PRIVATE_MONITOR_TARGETS` unset or `false` in production so
  monitors cannot probe private networks (SSRF protection).
- Terminate TLS in front of the app; only its port needs to be public.
  The database is never exposed to the internet in the shipped setup.
- Keep `.env` out of version control. It already is, via `.gitignore`.

What ships hardened by default: security headers, non-root container
images, RBAC guards on every mutation, HMAC-signed webhooks, the
outbound egress policy below, and a readiness endpoint that checks the
database and the migration state rather than only the connection.
The full security model is documented in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Outbound requests, the egress policy

Vigil makes outbound requests on your behalf from a growing number of
places: monitor probes, the redirects those probes follow, the requests
an API journey issues, notification-channel deliveries to twenty-five
provider types, webhook delivery, the importer reading your old
monitoring account, runbook steps that call an endpoint, and recovery
triggers. Every one of them goes through one policy
(`src/modules/monitors/egress.ts`) on one of three channels (`monitor`,
`webhook` or `recovery`), so a rule learned in one is a rule everywhere,
and a new caller inherits the posture rather than inventing one.

**The floor, which no setting can lower.** Cloud instance-metadata
addresses (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`,
`metadata.google.internal`), the whole link-local range
(`169.254.0.0/16`, `fe80::/10`), the unspecified address, and reserved
space (multicast, broadcast, TEST-NET, benchmarking, future-use) are
unreachable on every channel, whatever else is configured. The check is
on the _classified address_, not on the text of the URL, so every
encoding of the same address is refused, including
`[::ffff:169.254.169.254]`, `[::ffff:a9fe:a9fe]`, `64:ff9b::a9fe:a9fe`
and `2002:a9fe:a9fe::`.

**Private space, which is yours to decide, per channel.**

| Variable                         | Default | What it governs                                             |
| -------------------------------- | ------- | ----------------------------------------------------------- |
| `ALLOW_PRIVATE_MONITOR_TARGETS`  | `false` | Whether monitor probes may reach RFC1918/CGNAT/ULA/loopback |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS`  | `true`  | Same, for org webhook delivery                              |
| `ALLOW_PRIVATE_RECOVERY_TARGETS` | `true`  | Same, for recovery triggers                                 |

The last two default to allow because a self-hosted install routinely
posts to a receiver on its own network, and a recovery hook on an
internal address is the entire point of the feature. Set them to
`false` on a deployment where those URLs are not typed by someone you
trust.

**Every redirect hop is a separate decision.** Redirects are followed by
an explicit loop that resolves and classifies each hop before issuing
it; the HTTP client is never asked to follow one. Webhook and recovery
delivery follow none at all. A redirect would downgrade the signed POST
to an unsigned GET and move it to a host you never configured, and
report the 3xx as a delivery failure. Credentials (`Authorization`,
`Cookie`, `X-Vigil-Signature`) are dropped on any hop that crosses
origins.

**The address that was checked is the address that is used.** The
HTTP-family paths resolve DNS themselves and hand the resolved address
to the connection, keeping the original hostname for the `Host` header
and the TLS certificate check. A DNS server that answers one thing to
the guard and another to the connector therefore has nothing to gain:
there is only one lookup. Validation is redone from scratch on every
request and every retry, never cached across them.

**Approved exceptions are recorded.** Whenever policy permits a request
into non-public space, an `egress.exception` event is logged with the
channel, hostname, resolved address, its classification, the redirect
hop, and the URL with credentials and query string stripped. Ship your
logs somewhere and this is your outbound audit trail.

### Known residual risk

The non-HTTP check types, `tcp`, `tls-expiry`, `smtp`, `ping`,
`docker`, and the database probes, resolve and classify the target the
same way, but then open their own socket through a driver that performs
its own lookup. A DNS server that changes its answer between those two
moments has a window there. It is a small one and it is not a redirect
chain, but it is real, and closing it needs a pinned address threaded
through drivers that do not all expose one. The HTTP-family paths,
webhook delivery and recovery triggers do not have this window.

## Automatic recovery, the safety model

Recovery is the one feature that makes an outbound, state-changing
request to an address you supply, so it is deliberately the most
constrained path in the product:

- **Off until you turn it on, per monitor.** No recovery request is
  ever sent unless you saved a recovery action and enabled it. A fresh
  install never calls out.
- **Cloud metadata endpoints are blocked at input and again at
  execution.** A recovery URL that _is_ a metadata or link-local address
  is rejected when you save it, in any encoding. That is only the early
  answer: the hostname you saved has a DNS record you do not own
  forever, so the trigger resolves and classifies it again at the moment
  it fires, and refuses then too. Unlike monitor targets, recovery
  endpoints are allowed to be private/internal hosts on purpose. The
  whole point is to reach a restart hook inside your own network, which
  you configured. See the egress policy above for the exact ranges and
  for `ALLOW_PRIVATE_RECOVERY_TARGETS`.
- **It's your endpoint, and it can verify the caller.** Every trigger is
  signed (`X-Vigil-Signature`, HMAC-SHA-256, same scheme as webhooks),
  so your receiver can reject anything that isn't Vigil before it acts.
  A one-file example receiver ships in `examples/recovery-receiver.mjs`.
- **"Verified" means verified-in-time.** Before firing, the worker
  re-probes to confirm the failure is still happening (so a one-off
  blip doesn't trigger a restart); after firing, it probes again before
  calling recovery a success. This removes transient false positives.
  By default those probes run from the single host you deploy Vigil on,
  so it is verification in time and not across vantage points.
- **Remote probes do not widen this.** A monitor executed by probe
  agents reaches recovery through the same path and the same guard: the
  quorum's conclusion becomes an ordinary verdict, and only a verdict of
  `down` opens an incident and starts the chain. Insufficient quorum, an
  unavailable fleet and a controller timeout are all `indeterminate`,
  which opens no incident and therefore fires no trigger. A fleet that
  went to sleep can never restart your production database. That is
  asserted from outside the module in
  `tests/integration/probe-semantics.test.ts`, which counts the enqueued
  recovery jobs rather than trusting the branch.
- **Recovery triggers still fire from the controller, never from a
  probe.** A probe measures and reports; it holds no recovery
  configuration, is never told one, and has no code path that can send a
  signed trigger. A compromised probe can lie about one target's health.
  It cannot make anything happen to your infrastructure.
- **Bounded and audited.** Attempts are capped per incident (1-5) with a
  cooldown, capped per monitor per day (restart-loop guard), and every
  attempt is an immutable record with pre-check, delivery, verification
  and timings. Nothing recovery does is silent.

## Remote probe agents

Added in 1.14.0, commercial edition, off unless a monitor is assigned to
one. The trust boundary is worth stating plainly, because a probe is a
process on a machine Vigil does not control:

- **A probe holds one credential, scoped to one probe and one
  organization.** It is `vgp_` plus 256 bits of CSPRNG output, stored as
  SHA-256 and shown once at enrollment or rotation. There is no endpoint,
  service function or audit row that can produce it again.
- **A probe can do exactly three things**: enrol once, ask for its own
  work, and answer its own jobs. It cannot read another probe's job,
  another tenant's anything, or any monitor it was not assigned. Every
  lookup is scoped by both the probe id and the organization id.
- **A probe cannot page anyone.** The results endpoint writes rows and
  nothing else, for the same reason `/api/push/<token>` does: an
  endpoint outside the trust boundary that opens incidents and sends
  email is an amplifier pointed at your own operators. The conclusion is
  drawn by the worker, from rows, on the controller's own clock.
- **A probe's clock is never trusted.** Freshness, expiry and quorum are
  judged on the controller's clock. The probe's is recorded so you can
  see a drifting box, clamped so that a container with no real-time
  clock cannot overflow a column and take the endpoint down.
- **The agent applies its own egress policy**, from its own environment.
  The controller cannot widen it remotely, and the never-reachable floor
  (metadata, link-local, unspecified, reserved) is refused in every
  encoding regardless.
- **The agent holds no database credential.** It overwrites
  `DATABASE_URL` at start-up before anything can read it, so pasting the
  controller's `.env` into a probe container does not put production
  database credentials on a remote box.
- **Revocation is immediate and total**, clearing both hashes and
  refusing on a separate flag, so two independent things have to fail
  before a revoked credential works. The probe's history is kept:
  deleting the agent to tidy the list would rewrite the evidence for
  every decision it took part in.

The residual risk, stated: anyone who can read the credential file on a
probe's volume is that probe. Give it a volume the host protects, and
revoke from the Probes page if it is lost. A compromised probe can
report false measurements about the targets it was assigned, which is
what the quorum is for and why the default is `majority` rather than
`any`.

## Scripted synthetics, and the browser runner

A journey is **data**, never code. There is no scripting surface at all:
no expression evaluator, no template with function calls, no regular
expressions, and no `page.evaluate`. What an operator writes is a list of
typed steps, and the only thing their text can become is a value - a URL,
a CSS selector, something typed into a field, or a string compared
against page content. The set of things a journey can be made to do is
the set of step kinds in the language, and it cannot be extended from
outside the repository. `docs/SYNTHETICS.md` §1 states the reasoning at
length.

API journeys execute inside the worker through the egress policy above,
so they have the same posture as the `http` type. Browser journeys are
executed by a **separate runner container**, and Vigil closes the gap the
egress policy cannot cover on its own from both ends: every host a
journey may reach is resolved and classified by the worker before
dispatch, and the runner refuses a main-frame navigation to any host that
was not on that list.

### The runner is internal, and that is enforced

The runner is not a remote agent and has no enrolment protocol. Unlike a
probe agent, which is outbound-only and dials the controller, the worker
dials the runner - so it has to be reachable, and what is reachable is a
browser that renders whatever it is told to, receiving request bodies
that carry the journey's credentials.

Vigil therefore refuses unsafe deployments rather than warning about
them, in both directions:

| Where the runner is | What is required                    |
| ------------------- | ----------------------------------- |
| loopback            | nothing; the kernel is the boundary |
| private network     | a shared token                      |
| public address      | **https and a shared token**        |

The controller checks this **before it builds the request body**, so a
journey's secrets are never transmitted on a connection that would have
been refused. The runner itself refuses to start when it listens on
anything but loopback with no token set. A container network is not an
exemption: everything else on it can reach the runner, including a
browser that has just rendered somebody else's page.

Tokens are compared in constant time against a SHA-256 of the presented
value. Rotation is a restart with a new value on both sides; the runner
holds no state, so there is nothing to migrate.

### What a compromised runner has

One journey at a time and the values it was given. No database
credential, no session secret, no organization id, no monitor list, and
no route that reports what else exists. That is asserted by a test that
walks the runner's real import graph, not merely claimed here.

### Evidence, and what is deliberately not stored

Run evidence never contains a request header value, a cookie value, or an
extracted value - only their names. A URL that a secret was interpolated
into is stored without its query string. Every string that does reach
evidence is scrubbed against the run's secret values in raw,
percent-encoded, form-encoded, JSON-escaped and base64 forms, and the
scrubber re-checks its own output and withholds anything it could not
clean. Screenshots mask password inputs and every field a secret was
typed into.

Journeys are never dispatched to remote probes, because a run is recorded
to a database a probe agent holds no credential for.

## Reducing the trust surface

- `GITHUB_TOKEN` and any recovery/webhook receiver you build should have
  the narrowest scope that works.
- Grant the `viewer` role freely. It is read-only and never sees
  signing secrets or mutation controls.
