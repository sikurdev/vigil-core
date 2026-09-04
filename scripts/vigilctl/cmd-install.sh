# shellcheck shell=bash
#
# `vigilctl install` — bring the Compose stack up, from nothing or from
# whatever state the last attempt left behind.
#
# Idempotent because installs get interrupted. The operator loses the
# ssh session during the image build, the host reboots, the first run
# refused because Docker was not running yet. Every step here either
# already holds or is safe to perform again, so the recovery from any of
# those is the same command, and the second run tells you it changed
# nothing rather than pretending to have done the work twice.
#
# What it does NOT do is decide anything about the database that already
# exists. `POSTGRES_PASSWORD` is the sharp edge: it initializes the role
# on the volume first creation and is ignored forever after, so
# generating one for an install that already has a volume would write a
# password into .env that Postgres has never heard of and lock the app
# out of its own database. See `ensure_config`.

install_usage() {
  cat <<'TXT'
Usage: vigilctl install [OPTIONS]

Start (or repair) the Docker Compose install: validate prerequisites,
create or preserve the secrets in .env, build the images, run the
migrations, start the app and the worker, and wait for real health.

Options:
      --yes                 do not ask anything; take the defaults
      --allow-customized    proceed even though this is not the stock stack
      --timeout SECONDS     how long to wait for health (default 300)
  -h, --help

Exit codes: 0 installed or repaired, 10 already installed and healthy,
20 refused, 1 failed.
TXT
}

cmd_install() {
  local allow_customized="no" timeout=300
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-customized)
        allow_customized="yes"
        shift
        ;;
      --timeout)
        timeout="${2:-}"
        [ -n "$timeout" ] || usage_error "--timeout needs a number of seconds"
        shift 2
        ;;
      -h | --help)
        install_usage
        exit "$EX_OK"
        ;;
      *) usage_error "install does not take $1" ;;
    esac
  done
  case "$timeout" in
    '' | *[!0-9]*) usage_error "--timeout takes a number of seconds" ;;
  esac

  require_docker
  assert_stock_stack "$allow_customized"

  ensure_config

  # ── the reason this does not just run `up` and compare afterwards ──
  #
  # `docker compose up -d --build` is NEVER a no-op on this stack, even
  # with every layer cached and nothing to change. The app and the worker
  # depend on `migrate` with `service_completed_successfully`, and a
  # one-shot in `exited` state is recreated on every `up` - so its
  # dependents are recreated with it, and a second install would restart
  # a perfectly healthy installation in order to prove it had nothing to
  # do. Measured on the real stack rather than reasoned about: compose
  # reported "Container vigil-app-1 Recreate" on the second run of an
  # install that changed nothing at all.
  #
  # So the question is asked before anything is started. The running
  # stack is what the configuration asks for when `.env` is byte for byte
  # the one the last successful install started it with - which covers
  # both a secret vigilctl just generated and an edit the operator made
  # by hand - and everything is healthy. Any doubt at all, a missing
  # stamp included, means `up` runs: not restarting when a restart was
  # needed is the worse of the two mistakes.
  if install_stamp_matches && stack_healthy; then
    say "already installed and healthy, nothing changed"
    detail "Nothing was restarted. To rebuild and restart anyway: docker compose up -d --build"
    report_endpoint
    exit "$EX_NOOP"
  fi

  say "starting the stack (postgres, migrations, app, worker)"
  local log
  log="$(mktemp -t vigilctl-up.XXXXXX)"
  if ! compose up -d --build 2>&1 | tee "$log"; then
    diagnose_up_failure "$log"
  fi
  rm -f "$log"

  wait_for "postgres" 120 postgres_ready ||
    die "Postgres never started accepting connections." \
      "Read its output: docker compose logs postgres"
  wait_for "app health" "$timeout" app_ready ||
    die "the app never answered /api/ready within ${timeout}s." \
      "Read its output: docker compose logs app"
  wait_for "worker" "$timeout" worker_live ||
    die "the worker never recorded a scheduler pass within ${timeout}s." \
      "Nothing would be checking your monitors. Read its output: docker compose logs worker"

  # Only now, and only here: a stamp written before the health checks
  # would let the next run call a half-started stack "already installed".
  mkdir -p "$BACKUP_DIR"
  env_fingerprint >"$INSTALL_STAMP"

  say "installed"
  report_endpoint
  exit "$EX_OK"
}

# ── configuration ────────────────────────────────────────────────────
#
# Creates what is missing and never touches what is there. Both halves
# matter: a secret regenerated on a second install invalidates every
# session in the product, and a secret left empty stops both processes
# booting. Nothing here prints a value.
ensure_config() {
  if [ ! -f "$ENV_FILE" ]; then
    say "no .env, writing one"
    (
      umask 077
      cat >"$ENV_FILE" <<'TXT'
# Written by vigilctl install. Keep it: the secrets below are not in any
# database dump, and restoring a backup under a different
# BETTER_AUTH_SECRET signs every user out.
#
# Everything Vigil reads is documented in sample.env.production.
TXT
    )
    chmod 600 "$ENV_FILE"
  fi

  local secret
  secret="$(env_get BETTER_AUTH_SECRET)"
  if [ -z "$secret" ]; then
    env_put BETTER_AUTH_SECRET "$(gen_secret)"
    say "BETTER_AUTH_SECRET: generated, $(redact "$(env_get BETTER_AUTH_SECRET)")"
  elif [ "${#secret}" -lt 32 ]; then
    refuse "BETTER_AUTH_SECRET in .env is ${#secret} characters and the app requires 32." \
      "vigilctl will not replace it for you: sessions and status-page subscription tokens are signed with it, and changing it signs everyone out. Set a longer one yourself, then re-run."
  else
    say "BETTER_AUTH_SECRET: preserved, $(redact "$secret")"
  fi

  local pgpass
  pgpass="$(env_get POSTGRES_PASSWORD)"
  if [ -n "$pgpass" ]; then
    say "POSTGRES_PASSWORD: preserved, $(redact "$pgpass")"
  elif pgdata_volume_exists; then
    # The volume already holds a role whose password was set when it was
    # initialized, and POSTGRES_PASSWORD is read only at that moment.
    # Writing a new one here would leave .env and the database
    # disagreeing, and the symptom is the app failing to authenticate
    # against a database that is perfectly healthy.
    warn "note: POSTGRES_PASSWORD is not set and the database volume already exists."
    detail "The role was created with the compose default. vigilctl is not changing it, because the value is only read when the volume is first initialized, and writing a new one here would lock the app out."
    detail "To change it: ALTER ROLE vigil WITH PASSWORD ... inside the container, then set POSTGRES_PASSWORD in .env to match."
  else
    env_put POSTGRES_PASSWORD "$(gen_password)"
    say "POSTGRES_PASSWORD: generated, $(redact "$(env_get POSTGRES_PASSWORD)")"
  fi

  local app_url
  app_url="$(env_get APP_URL)"
  if [ -z "$app_url" ]; then
    app_url="$(ask_app_url)"
    env_put APP_URL "$app_url"
    say "APP_URL: set to $app_url"
  else
    say "APP_URL: preserved, $app_url"
  fi
}

# The one question worth asking, because getting it wrong has a symptom
# nobody connects to it: APP_URL is the auth trusted origin, so a
# mismatch rejects every browser sign-in while curl keeps working.
ask_app_url() {
  local default="http://localhost:3000" answer=""
  if [ "$ASSUME_YES" = "yes" ] || [ ! -t 0 ]; then
    printf '%s' "$default"
    return 0
  fi
  printf 'vigilctl: what origin will people type into their browser?\n' >&2
  printf '  It must match exactly, scheme and port included [%s]: ' "$default" >&2
  read -r answer || true
  printf '%s' "${answer:-$default}"
}

# ── failure, named ───────────────────────────────────────────────────
#
# `docker compose up` fails for three reasons that need three different
# things from the operator, and its own output buries which one it was
# under a hundred lines of build log. One reason, one next command.
diagnose_up_failure() {
  local log="$1" code
  code="$(service_exit_code migrate)"
  if [ -n "$code" ] && [ "$code" != "0" ]; then
    die "the database migrations failed (the migrate job exited $code)." \
      "Nothing was started on top of them. Read: docker compose logs migrate"
  fi
  if grep -qE 'failed to solve|ERROR: failed to build|error building' "$log"; then
    die "the container images did not build." \
      "The build output is above. Nothing in the running stack was changed."
  fi
  die "docker compose could not start the stack." \
    "The output is above. ./vigilctl doctor will say which part is missing."
}

report_endpoint() {
  local url published
  url="$(env_get APP_URL)"
  [ -n "$url" ] || url="http://localhost:3000"
  detail "Vigil is at $url"
  published="$(compose port app 3000 2>/dev/null || true)"
  if [ -n "$published" ] && [ "$url" != "http://$published" ]; then
    detail "The container publishes port 3000 on $published. Point your reverse proxy there."
  fi
}
