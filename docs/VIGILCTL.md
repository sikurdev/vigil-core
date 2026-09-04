# vigilctl

The lifecycle of a self-hosted Vigil install, as one command.

```bash
./vigilctl install            # start it, or repair it
./vigilctl doctor             # what is wrong, changing nothing
./vigilctl backup             # a dump, proved readable
./vigilctl restore ARCHIVE    # put one back, then prove the stack works
./vigilctl update --to REF    # move to a version you name
./vigilctl rollback           # undo the last update, code and data
```

Bash and Docker are the only requirements. No npm, no Node, no Postgres
client on the host: the machine that runs the supported install has
Docker on it and frequently nothing else.

## What this is not

It is not a second deployment system. The deployment is
[docker-compose.yml](../docker-compose.yml), the backup path is
`scripts/backup.sh` and `scripts/restore.sh`, the migration path is the
one-shot `migrate` service, and all of that is documented in
[DEPLOYMENT.md](DEPLOYMENT.md) and [BACKUP.md](BACKUP.md). vigilctl runs
them in the right order, refuses the orders that are unsafe, and waits
for real health rather than reporting that a container started.

Every underlying command is still there and still supported. Nothing
here takes an escape hatch away, and the last section of this page lists
them.

## Exit codes

Four outcomes, four numbers, the same for every command. A wrapper
script has to be able to tell them apart, and "did it print the word
success" is not a contract.

| Code | Meaning                                                |
| ---- | ------------------------------------------------------ |
| 0    | success: the command did the thing it names            |
| 10   | no-op: already in the requested state, nothing changed |
| 20   | refused: a precondition said no. Nothing changed       |
| 1    | failure: it tried and did not finish                   |
| 2    | usage: the arguments were wrong                        |

The distinction between 20 and 1 is the one that matters at 3am. A
refusal is safe to ignore or to override; a failure is not.

`doctor` uses the same numbers for a related question: 0 healthy, 10
healthy with warnings, 1 at least one failure.

## install

```bash
./vigilctl install [--yes] [--allow-customized] [--timeout SECONDS]
```

Validates the prerequisites, creates or preserves the secrets in `.env`,
builds the images, runs the migrations, starts the app and the worker,
waits for real health, and prints the endpoint.

Idempotent, because installs get interrupted. The ssh session drops
during the build, the host reboots, the first run refused because Docker
was not up yet. Every step either already holds or is safe to perform
again, so the recovery from all of those is the same command.

**A repeat install does not restart anything.** That is worth stating
because `docker compose up -d --build` is never a no-op on this stack:
the app and the worker depend on the one-shot `migrate` job, a one-shot
in `exited` state is recreated on every `up`, and its dependents are
recreated with it. So an install that ran `up` to find out whether it
had work would bounce a healthy installation every time. vigilctl asks
first instead: when `.env` is byte for byte the file the last successful
install started the stack with, and everything is healthy, it exits 10
and touches nothing. Anything else, a missing record included, and it
runs `up`. To rebuild and restart regardless, that is what
`docker compose up -d --build` is for.

**Secrets are created once and preserved forever after.**
`BETTER_AUTH_SECRET` signs every session and every status-page
subscription token, so regenerating it on a second install would sign
your whole installation out. If one is already set, vigilctl says
`preserved` and moves on. If one is set but shorter than the 32
characters the app requires, vigilctl **refuses** rather than replacing
it, because replacing it is the destructive option.

`POSTGRES_PASSWORD` has a sharper edge and is handled separately. It
initializes the database role the first time the volume is created and
is ignored on every start after that. So vigilctl generates one only
when there is no volume yet. Where a volume already exists and no
password is set, it says so and leaves it alone: writing one would put a
value in `.env` that Postgres has never heard of, and the symptom is the
app failing to authenticate against a database that is perfectly
healthy.

Nothing prints a secret. Values are reported as `set (44 characters)`,
which is what a diagnosis needs and what a support thread can safely
contain.

## doctor

```bash
./vigilctl doctor
```

Read-only, and that is a promise rather than a description: doctor is
what you run when the install is already misbehaving, and a diagnostic
that starts containers changes the thing it was asked to describe. Every
call it makes is a `ps`, a `SELECT` or an HTTP GET.

It checks the prerequisites, the configuration, compose customization,
each service, the one-shot `migrate` job, Postgres, whether the
migration journal matches the migrations in this checkout, the app's
readiness endpoint, and whether the worker is still scheduling.

The worker check is the one worth knowing about. There is no worker HTTP
endpoint, so doctor asks the job queue: pg-boss stamps
`pgboss.version` whenever the process that owns cron runs a pass, and a
stamp older than five minutes means nothing is scheduling checks. That
is the most dangerous state a monitoring product has, because the
dashboard goes on showing the last status every monitor had and it looks
exactly like everything being fine.

## backup

```bash
./vigilctl backup [-o PATH]
```

Runs `scripts/backup.sh --docker`, which writes to a `.partial` name,
lists the archive with the `pg_restore` **inside the container** before
renaming it into place, and refuses to leave a file that looks finished
when it is not. Inside the container because that is where the pg_dump
that wrote it lives: a host client is often older than the server in the
image, and an older pg_restore reports a perfectly good archive as
unreadable. vigilctl
adds the check that the archive holds something: a readable archive of
an empty database parses perfectly, and a caller that asked for a backup
and got exit 0 will believe it has one.

The default output is `./backups/vigil-<utc timestamp>.dump`. A dump is
a credential file; [BACKUP.md](BACKUP.md) says exactly what is in one
and what is not.

## restore

```bash
./vigilctl restore ARCHIVE [--yes]
```

Destructive. Everything written since the archive was taken is gone.

The order is the whole of the command, because every step that can
refuse comes before every step that destroys:

1. the archive is readable, and holds objects
2. the operator confirms, by typing `restore` or by passing `--yes`
3. **the current database is dumped**, so the restore is itself
   reversible, and the path is printed
4. the app and the worker stop, because both write continuously
5. `scripts/restore.sh --docker --force` replaces the contents
6. the `migrate` job brings the schema up to the running build
7. everything starts, and health is waited for rather than assumed

Steps 1 and 2 cannot change anything. Without a terminal and without
`--yes`, step 2 refuses rather than reading EOF and treating it as
consent. Every failure after step 3 prints where the replaced database
is and the command that puts it back.

## update

```bash
./vigilctl update --to REF [--fetch] [--yes]
```

`--to` is required and is never defaulted. There is no channel to follow
and no version vigilctl will pick for you: a monitoring system that
upgrades itself is a monitoring system that can go down at 4am for a
reason nobody chose. `REF` is any tag, branch or commit in the checkout;
`--fetch` runs `git fetch --tags` first so that a tag published since
you cloned can be named.

The sequence, and why it is this sequence:

- **preflight**. The current stack must be healthy. An update applied to
  something already broken cannot be told apart from the thing that
  broke it.
- **backup**, taken and validated before anything moves, because it is
  the only thing that makes the next four steps reversible.
- **record**, written to `backups/vigilctl-rollback.state`: the commit
  that was installed, the one being installed, and the dump. On disk,
  because the shell that knows it is the shell that is about to fail.
- **checkout**, **build**, migrations, restart.
- **verify**: real health, not "docker says it started".

An update that resolves to the commit already installed is a no-op and
exits 10, but only when the record says the last update to it finished.
An update interrupted between the checkout and the build leaves the
target commit checked out with the old images still running, and
comparing HEAD to the target alone would call that state "already
installed". Re-running the same command finishes it instead: same
backup, same record, no second checkout. Starting over would back up a
half-migrated database and record the version being installed as the one
to go back to, which is the single change that would make the way back
unreachable.

Nothing rolls back on its own. A failed update leaves the stack where it
stopped and prints the one command that undoes it, because automatic
recovery from a state nobody has looked at is how a bad upgrade becomes
a bad upgrade plus a lost database.

## rollback

```bash
./vigilctl rollback [--yes]
```

Returns the checkout and the database to where they were before the last
update. Both, together: putting the old code on a database whose schema
a new migration has already changed is the state this exists to avoid
rather than to produce.

**There are no down-migrations and there will not be.** Vigil migrations
are forward-only: they are ordered files, upstream never rewrites one,
and several are not reversible in principle, because a column that was
dropped cannot be un-dropped by a script that does not have the values.
A generated `down` would be a file that runs, reports success and leaves
a schema nobody has ever tested. The pre-update dump is the reverse, and
it is a real one.

What that costs, stated plainly: anything written after the update is
not in that dump, and a rollback loses it. The confirmation says so in
those words. A dump of the current database is taken first, so the
rollback is itself reversible.

Rollback consumes its record, so a second run refuses. There is only one
step back.

## Refusals

vigilctl fails closed. Three families, and each prints one reason and
one next action.

**The stack is not the stock one.** vigilctl runs
`docker compose -f docker-compose.yml`, and naming a file turns off the
automatic loading of `docker-compose.override.yml`. On a host that has
one, vigilctl and your own `docker compose up` would build two different
stacks out of the same directory and neither would say so. A
`docker-compose.yml` with uncommitted changes is the same problem in the
other file. `install`, `restore`, `update` and `rollback` refuse; pass
`--allow-customized` to take responsibility for the difference, or drive
the install with `docker compose` directly. `doctor` reports it as a
warning, because a diagnostic that refuses to diagnose is useless.

**The project is running services vigilctl was not given.** The
synthetics runner and the remote-probe demo are Compose overlays that
deliberately share the base project name, so the worker can reach the
runner by service name. An installation running one of them is a single
stack that vigilctl holds only part of the definition of, and
`up --build` would rebuild the app and the worker and leave the runner
on the image it started with, silently. vigilctl looks for containers
carrying the project label whose service is not in
`docker-compose.yml`, and refuses when it finds any. `--allow-customized`
proceeds anyway; the honest alternative is to drive that install with
`docker compose` and both files.

**There is no version to move between.** `update` and `rollback` refuse
outside a git checkout, and refuse when tracked files have uncommitted
changes, because both check other commits out and would overwrite them.
Untracked files, which is what `.env` and `backups/` are, are nobody
else's business and are not looked at.

## The manual path is still there

Every command vigilctl runs is one you can run yourself, and
[DEPLOYMENT.md](DEPLOYMENT.md) and [BACKUP.md](BACKUP.md) remain the
reference for them:

```bash
docker compose up -d --build              # install and upgrade
docker compose logs app worker migrate    # what happened
docker compose run --rm migrate           # migrations only
bash scripts/backup.sh --docker -o out.dump
bash scripts/restore.sh --docker --force out.dump
```

Use them when your install is customized past the point where vigilctl
will drive it, and when you want a step vigilctl does not offer. The two
paths do the same things to the same stack; vigilctl is the one that
remembers the order.
