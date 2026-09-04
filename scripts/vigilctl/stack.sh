# shellcheck shell=bash
#
# Everything vigilctl knows about the shipped Compose stack.
#
# This file is the only place that runs `docker`, reads `.env` or asks
# Postgres a question. The subcommands are sequences of these; when one
# of them needs a new fact about the stack it goes here, so there is one
# answer to "is the worker running" rather than six.
#
# Nothing here builds a second deployment system. `docker-compose.yml`
# is the deployment, `scripts/backup.sh` and `scripts/restore.sh` are the
# backup path, and `drizzle-kit migrate` in the `migrate` service is the
# migration path. This orchestrates those and adds no state of its own
# except the rollback record, which is one file.

ENV_FILE="$REPO/.env"
COMPOSE_FILE="$REPO/docker-compose.yml"
# Docker Compose loads this automatically beside the project file, and
# it can redefine any service in the stack. See `assert_stock_stack`.
OVERRIDE_FILE="$REPO/docker-compose.override.yml"
BACKUP_DIR="$REPO/backups"
ROLLBACK_STATE="$BACKUP_DIR/vigilctl-rollback.state"
# Holds a fingerprint of the `.env` the running stack was started with,
# written at the end of a successful install. See `cmd_install`: it is
# how a repeat install can tell that the running stack is already the one
# the current configuration asks for, and therefore must not be
# restarted.
INSTALL_STAMP="$BACKUP_DIR/vigilctl-install.stamp"

# The services vigilctl manages. `migrate` is deliberately not here: it
# is a one-shot job, not something that is ever expected to be running.
STACK_SERVICES="postgres app worker"

# Everything `docker-compose.yml` defines, which is what vigilctl drives.
# Anything else running under the same project name came from an overlay
# vigilctl was not given, and `unmanaged_services` is how it finds out.
BASE_SERVICES="postgres migrate app worker"

compose() {
  docker compose --project-directory "$REPO" -f "$COMPOSE_FILE" "$@"
}

# ── prerequisites ────────────────────────────────────────────────────
#
# Three questions, asked in the order that makes the answer useful: is
# the client installed, does it have Compose v2, is there a daemon to
# talk to. Asked in any other order, a machine with no Docker at all
# reports "the daemon is not reachable", which sends the operator to
# read a socket permission page about software they have not installed.

# Prints the first problem and its remedy, tab separated, or nothing at
# all when Docker is usable. Two callers want two different things out
# of the same three questions: every state-changing command wants to
# stop, and `doctor` wants to report and carry on to the next check. A
# predicate that only knew how to exit would have forced doctor to ask
# them again in its own words, which is how two answers to one question
# start to disagree.
docker_problem() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is not installed, or not on this shell PATH.\tInstall Docker Engine and re-run: https://docs.docker.com/engine/install/'
    return 0
  fi
  if ! docker compose version >/dev/null 2>&1; then
    printf 'this Docker has no Compose v2 plugin (docker compose version failed).\tInstall the docker-compose-plugin package. Standalone docker-compose v1 is not supported.'
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    printf 'the Docker daemon is not reachable.\tStart it, or add this user to the docker group, and re-run.'
    return 0
  fi
  return 0
}

require_docker() {
  local problem
  problem="$(docker_problem)"
  [ -n "$problem" ] || return 0
  die "${problem%%$'\t'*}" "${problem##*$'\t'}"
}

# Services running under this project that `docker-compose.yml` does not
# define.
#
# The two commercial overlays, `docker-compose.synthetics.yml` and
# `docker-compose.probes.yml`, deliberately share the base project name
# so the worker can reach the runner by service name. That makes an
# installation running either of them ONE stack, and vigilctl is holding
# only part of its definition: `up --build` would rebuild the app and
# the worker and leave the runner on the image it was started with,
# silently, which is worse than not touching the install at all.
#
# Asked of Docker rather than of the filesystem. Both overlay files ship
# with the commercial edition whether or not an operator ever started
# them, so their presence says nothing; a container carrying the project
# label says everything. Core has neither file and this finds nothing
# there, which is why the check costs it nothing.
unmanaged_services() {
  local deployed name out=""
  deployed="$(docker ps -a \
    --filter "label=com.docker.compose.project=$(compose_project)" \
    --format '{{.Label "com.docker.compose.service"}}' 2>/dev/null |
    sort -u)"
  for name in $deployed; do
    case " $BASE_SERVICES " in
      *" $name "*) ;;
      *) out="$out $name" ;;
    esac
  done
  printf '%s' "${out# }"
}

# ── is this the stack we know how to drive ───────────────────────────
#
# vigilctl runs `docker compose -f docker-compose.yml`. Naming a file
# turns off the automatic loading of docker-compose.override.yml, so on
# a host that has one, vigilctl and the operator's own `docker compose up`
# would build two different stacks out of the same directory and neither
# would say so. That is the failure worth refusing over: not
# customization itself, but two disagreeing definitions of one running
# system.
#
# A modified docker-compose.yml is the same problem in the other file.
# It is only answerable inside a git checkout, which the supported
# install is; outside one the question cannot be asked, and this returns
# without pretending it was.
#
# --allow-customized is the escape. It does not make vigilctl understand
# the customization; it records that the operator does.
assert_stock_stack() {
  local allow="$1"
  local reason="" extra=""

  extra="$(unmanaged_services)"
  if [ -f "$OVERRIDE_FILE" ]; then
    reason="docker-compose.override.yml is present, and vigilctl does not load it."
  elif [ -n "$extra" ]; then
    reason="this project is also running $extra, which docker-compose.yml does not define."
  elif git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    ! git -C "$REPO" diff --quiet HEAD -- docker-compose.yml 2>/dev/null; then
    reason="docker-compose.yml has uncommitted changes."
  fi

  [ -n "$reason" ] || return 0
  if [ "$allow" = "yes" ]; then
    warn "note: $reason Continuing because --allow-customized was given."
    return 0
  fi
  refuse "$reason" \
    "vigilctl drives the stock stack. Pass --allow-customized to own the difference, or manage this install with docker compose directly."
}

# ── .env ─────────────────────────────────────────────────────────────
#
# Read with sed rather than sourced. The file belongs to the operator
# and holds values this script has no business executing: a password
# containing a dollar sign or a command substitution is an ordinary
# password and a catastrophic thing to eval.

env_get() {
  local key="$1"
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" |
    awk '{ last = $0 } END { if (NR) print last }'
}

# Replaces the value in place when the key is there and appends when it
# is not, so comments, ordering and every key vigilctl does not know
# about survive untouched. Written to a temporary file in the same
# directory and moved over it, so an interrupted run cannot leave a
# half-written .env: either the old file or the new one, never neither.
env_put() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if [ -f "$ENV_FILE" ] && grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" '
      !done && $0 ~ "^[[:space:]]*" k "=" { print k "=" v; done = 1; next }
      { print }
    ' "$ENV_FILE" >"$tmp"
  else
    [ ! -f "$ENV_FILE" ] || cat "$ENV_FILE" >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# What the configuration currently says, in one line, so a later run can
# tell whether it has changed.
#
# Content and not a timestamp. The obvious version of this compared the
# modification time of `.env` against the stamp, and on a filesystem
# whose timestamps have one-second granularity an edit made in the same
# second as the install it followed was invisible. `cksum` is POSIX,
# present wherever this runs, and answers the only question being asked:
# are these the same bytes. Nothing here is a security property - a
# fingerprint that collided would cost a missed restart, not a secret.
env_fingerprint() {
  [ -r "$ENV_FILE" ] || {
    printf 'absent'
    return 0
  }
  cksum <"$ENV_FILE" | awk '{ print $1 "-" $2 }'
}

# Whether the running stack was started with the configuration that is
# on disk now.
install_stamp_matches() {
  [ -f "$INSTALL_STAMP" ] || return 1
  [ "$(env_fingerprint)" = "$(cat "$INSTALL_STAMP")" ]
}

# 32 bytes of real entropy. openssl is on nearly every host that runs
# Docker and /dev/urandom is on the rest. There is no third fallback on
# purpose: a weak default here is a signing key somebody can guess, and
# refusing to install is the better failure.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  elif [ -r /dev/urandom ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  else
    die "no source of randomness (neither openssl nor /dev/urandom)." \
      "Set BETTER_AUTH_SECRET and POSTGRES_PASSWORD in .env by hand and re-run."
  fi
}

# A Postgres password with the base64 punctuation taken out. The value
# travels inside a connection URL that compose builds by string
# concatenation, and a `/` or a `+` in there produces a URL that parses
# as something else. Thirty-two characters of the remaining alphabet is
# still far more entropy than anything reachable over a socket needs.
gen_password() {
  local raw
  raw="$(gen_secret)"
  printf '%s' "$raw" | tr -cd 'A-Za-z0-9' | cut -c1-32
}

# ── the project, and its volume ──────────────────────────────────────
#
# Compose resolves the project name from COMPOSE_PROJECT_NAME, then the
# `name:` key in the file, then the directory. Resolved the same way
# here rather than asked of a container, because the question that needs
# it is asked when there is no container: after `docker compose down`
# the volume outlives every container in the project, and that surviving
# volume is exactly what makes a generated POSTGRES_PASSWORD dangerous.
compose_project() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi
  local name
  name="$(awk '/^name:[[:space:]]*[^[:space:]]/ {
    sub(/^name:[[:space:]]*/, "")
    gsub(/["'"'"']/, "")
    print
    exit
  }' "$COMPOSE_FILE")"
  [ -n "$name" ] ||
    name="$(basename "$REPO" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  printf '%s' "$name"
}

pgdata_volume_exists() {
  docker volume inspect "$(compose_project)_pgdata" >/dev/null 2>&1
}

# ── the running stack ────────────────────────────────────────────────
#
# `awk NR==1` rather than `head -1` throughout. head closes the pipe as
# soon as it has what it wants, the writer dies of SIGPIPE, and under
# `set -o pipefail` that becomes the status of the whole pipeline: a
# check that read its line and then reported failure for it.

service_state() {
  compose ps -a --format '{{.State}}' "$1" 2>/dev/null | awk 'NR==1'
}

service_exit_code() {
  compose ps -a --format '{{.ExitCode}}' "$1" 2>/dev/null | awk 'NR==1'
}

# ── Postgres ─────────────────────────────────────────────────────────
#
# Asked through the container rather than from the host, because the
# supported install has no Postgres client on the host. It has Docker,
# and the client tools are inside the image it already pulled.

psql_q() {
  compose exec -T postgres psql -U vigil -d vigil -tAc "$1" 2>/dev/null |
    tr -d '\r' | awk 'NR==1'
}

postgres_ready() {
  compose exec -T postgres pg_isready -U vigil -d vigil >/dev/null 2>&1
}

# Migrations shipped in this checkout, and migrations this database has
# recorded. drizzle-kit writes one row into `drizzle.__drizzle_migrations`
# per journal entry it applies, and the journal travels inside the dump,
# so the two numbers stay comparable across a restore as well as across
# an upgrade.
#
# Counted from `meta/_journal.json` rather than from the directory
# listing, because the journal is what drizzle-kit actually applies. The
# two agree today; a `.sql` added without its journal entry would make a
# file count report migrations pending forever against a database that
# is completely up to date.
migrations_on_disk() {
  local journal="$REPO/drizzle/meta/_journal.json"
  if [ -r "$journal" ]; then
    grep -c '"when"' "$journal" | tr -d ' ' || true
    return 0
  fi
  find "$REPO/drizzle" -maxdepth 1 -name '*.sql' -type f 2>/dev/null |
    wc -l | tr -d ' '
}

migrations_applied() {
  psql_q "select count(*) from drizzle.__drizzle_migrations"
}

# ── the app ──────────────────────────────────────────────────────────
#
# Health is asked of the app the way the container healthcheck asks it,
# from inside the container. Not from the host: that would additionally
# test the published port and whatever is in front of it, and a reverse
# proxy in the way would make a healthy app report sick.
#
# READINESS, not liveness: /api/ready answers 200 only when Postgres is
# reachable AND every migration this build ships has been applied, so the
# one call covers the pair — and, unlike the `select 1` it replaced, it
# refuses an empty or half-migrated database instead of calling it well.
# `migrations_applied` above asks the same question from outside; when
# the two disagree, the app is running against a different database from
# the one this checkout points at.
# Falls back to `/api/health` on a 404, and that is not belt and braces:
# `rollback` checks out a PREVIOUS release and rebuilds from it, while
# the shell functions already loaded in this process are the new ones. A
# release from before `/api/ready` existed answers 404 forever, so a
# probe that only knew the new path would report every rollback across
# this boundary as a failed one - and `rollback_failed` is not a warning,
# it leaves the operator believing the rollback did not happen.
#
# `/api/health` is the alias every release since 1.0 serves, and it means
# whatever the running release means by it: readiness here, "can reach
# Postgres" there. Asking for the strict path first and accepting the
# alias second gets the strictest answer the running code can give.
app_ready() {
  compose exec -T app node -e "
    const ask = (p) =>
      fetch('http://127.0.0.1:3000' + p).then((r) =>
        r.status === 404 ? null : r.json().then((b) => r.ok && b.status === 'ok'),
      );
    ask('/api/ready')
      .then((ok) => (ok === null ? ask('/api/health') : ok))
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch(() => process.exit(1));
  " >/dev/null 2>&1
}

# ── the worker ───────────────────────────────────────────────────────
#
# There is no worker HTTP endpoint to probe, and the fleet table that
# records worker heartbeats is a commercial feature, so this asks the
# queue both editions share.
#
# pg-boss installs its schema on the first successful worker start and
# stamps `pgboss.version` whenever the process that owns cron runs a
# pass. A recent stamp is a worker that is alive and doing the one thing
# that makes checks happen. A missing stamp on a stack that has only
# just come up is not yet a failure, and the callers treat it that way.
#
# Prints seconds since the last pass, `none` when the queue is installed
# but has run none, and `absent` when the worker has never finished
# starting.
worker_cron_age() {
  local present age
  present="$(psql_q "select to_regclass('pgboss.version') is not null")"
  if [ "$present" != "t" ]; then
    printf 'absent'
    return 0
  fi
  # Clamped at zero. A negative age is possible for a moment after a
  # clock adjustment, and a caller that parses this as a number would
  # otherwise read a minus sign as "not a number" and call the worker
  # dead, while doctor read it as "very recent" and called it fine.
  age="$(psql_q "select coalesce(greatest(0, floor(extract(epoch from now() - greatest(cron_on, bam_on, flow_on))))::text, 'none') from pgboss.version")"
  [ -n "$age" ] || age="none"
  printf '%s' "$age"
}

worker_live() {
  local age
  age="$(worker_cron_age)"
  case "$age" in
    absent | none) return 1 ;;
    *[!0-9]*) return 1 ;;
    *) [ "$age" -le "$WORKER_STALE_SECONDS" ] ;;
  esac
}

# The whole install in one predicate: three containers up, the app
# answering with a database behind it, and the worker scheduling. Used
# to decide whether a repeat install changed anything and to prove a
# restore or a rollback actually landed.
stack_healthy() {
  local service
  for service in $STACK_SERVICES; do
    [ "$(service_state "$service")" = "running" ] || return 1
  done
  app_ready || return 1
  worker_live
}

# ── waiting ──────────────────────────────────────────────────────────
#
# One deadline against the shell's own clock, so a command that was
# interrupted and re-run waits the same amount again rather than
# inheriting whatever the last attempt had left.
wait_for() {
  local what="$1" timeout="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  until "$@"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      return 1
    fi
    sleep 3
  done
  say "$what: ok"
  return 0
}

# ── archives ─────────────────────────────────────────────────────────
#
# Listing an archive is the cheapest proof that what was written can be
# read back, and it is the check that has to happen before anything
# destructive.
#
# Always through the container, never through the host. Every archive
# vigilctl handles was written by the pg_dump inside this stack, and only
# a pg_restore of at least that version can parse it. A host client is
# frequently older: an Ubuntu runner ships PostgreSQL 16 while this stack
# runs 18, and asking the 16 to read an 18 archive called a good backup
# corrupt. The supported install has no host client at all, which is the
# other half of the same answer.
archive_lists() {
  compose exec -T postgres pg_restore --list <"$1" >/dev/null 2>&1
}

archive_entries() {
  compose exec -T postgres pg_restore --list <"$1" 2>/dev/null |
    grep -c '^[0-9]' || true
}

# The dump taken immediately before a destructive operation, so that
# operation is itself reversible. Not a backup policy and never
# presented as one: it is the undo for the next ninety seconds. Prints
# the path it wrote, or nothing when the database held no tables and
# there was nothing to save.
safety_dump() {
  local label="$1" tables path
  tables="$(psql_q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_'")"
  if [ -z "$tables" ] || [ "$tables" = "0" ]; then
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  path="$BACKUP_DIR/$label-$(stamp).dump"
  (cd "$REPO" && bash scripts/backup.sh --docker -o "$path") >/dev/null ||
    die "could not take the safety dump that makes this reversible." \
      "Nothing has been changed. Fix the backup path first: bash scripts/backup.sh --docker"
  printf '%s' "$path"
}
