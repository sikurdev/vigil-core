# shellcheck shell=bash
#
# `vigilctl doctor` — read the install and say what is wrong with it.
#
# Read-only, and that is a promise rather than a description: doctor is
# what an operator runs when the install is already misbehaving, and a
# diagnostic that starts containers or writes config changes the thing
# it was asked to describe. Every call it makes is a `ps`, a `SELECT` or
# an HTTP GET.
#
# The exit code is the product. It is what a monitoring job or a
# maintenance script reads, and it means the same thing as everywhere
# else in this CLI: 0 all clear, 10 warnings only, 1 something is
# actually broken. Warnings are deliberately not failures, because a
# stack with DEMO_MODE on is doing exactly what it was told to.
#
# Nothing here prints a secret. See `redact` in common.sh.

DOCTOR_FAILURES=0
DOCTOR_WARNINGS=0

check_ok() {
  printf '  %sok%s    %-28s %s\n' "$C_OK" "$C_OFF" "$1" "${2:-}"
}
check_warn() {
  DOCTOR_WARNINGS=$((DOCTOR_WARNINGS + 1))
  printf '  %swarn%s  %-28s %s\n' "$C_WARN" "$C_OFF" "$1" "${2:-}"
}
check_fail() {
  DOCTOR_FAILURES=$((DOCTOR_FAILURES + 1))
  printf '  %sFAIL%s  %-28s %s\n' "$C_FAIL" "$C_OFF" "$1" "${2:-}"
}

doctor_usage() {
  cat <<'TXT'
Usage: vigilctl doctor

Diagnose the Docker Compose install without changing it.

Exit codes: 0 healthy, 10 healthy with warnings, 1 one or more failures.
TXT
}

cmd_doctor() {
  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help)
        doctor_usage
        exit "$EX_OK"
        ;;
      *) usage_error "doctor takes no arguments (got $1)" ;;
    esac
  done

  printf 'vigilctl doctor: %s\n\n' "$REPO"

  printf 'prerequisites\n'
  local problem
  problem="$(docker_problem)"
  if [ -n "$problem" ]; then
    check_fail "docker" "${problem%%$'\t'*}"
    detail "${problem##*$'\t'}"
    # Nothing below this line can be asked without Docker, and a wall of
    # failures that all mean "no Docker" buries the one that matters.
    printf '\n'
    doctor_verdict
  fi
  check_ok "docker" "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present)"
  check_ok "docker compose" "$(docker compose version --short 2>/dev/null || echo present)"

  printf '\nconfiguration\n'
  doctor_config

  printf '\nservices\n'
  doctor_services

  printf '\ndatabase\n'
  doctor_database

  printf '\napplication\n'
  doctor_app

  printf '\n'
  doctor_verdict
}

doctor_config() {
  if [ ! -f "$ENV_FILE" ]; then
    check_fail ".env" "missing"
    detail "Run: ./vigilctl install"
    return 0
  fi
  check_ok ".env" "present"

  # World or group readable .env on a multi-user host. A warning rather
  # than a failure: it is the operator host policy, and plenty of
  # single-purpose VMs have exactly one account on them.
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo '')"
  if [ -n "$mode" ] && [ "${mode: -2}" != "00" ]; then
    check_warn ".env permissions" "mode $mode, readable beyond its owner"
  elif [ -n "$mode" ]; then
    check_ok ".env permissions" "mode $mode"
  fi

  local secret
  secret="$(env_get BETTER_AUTH_SECRET)"
  if [ -z "$secret" ]; then
    check_fail "BETTER_AUTH_SECRET" "not set"
    detail "Neither the app nor the worker will start. Run: ./vigilctl install"
  elif [ "${#secret}" -lt 32 ]; then
    # Not a style preference: src/lib/env.ts requires 32 characters and
    # both processes refuse to boot below it.
    check_fail "BETTER_AUTH_SECRET" "$(redact "$secret"), the minimum is 32"
    detail "Replace it in .env. Every session and every status-page subscription token is signed with it, so changing it signs everyone out."
  else
    check_ok "BETTER_AUTH_SECRET" "$(redact "$secret")"
  fi

  local pgpass
  pgpass="$(env_get POSTGRES_PASSWORD)"
  if [ -z "$pgpass" ]; then
    check_warn "POSTGRES_PASSWORD" "not set, the compose default is in use"
    detail "The default is the literal string vigil. Set one in .env if this database is reachable from anywhere but this host."
  else
    check_ok "POSTGRES_PASSWORD" "$(redact "$pgpass")"
  fi

  local app_url
  app_url="$(env_get APP_URL)"
  if [ -z "$app_url" ]; then
    check_warn "APP_URL" "not set, defaulting to http://localhost:3000"
    detail "Browser sign-in is rejected when this does not equal the origin users type."
  else
    check_ok "APP_URL" "$app_url"
  fi

  case "$(env_get DEMO_MODE)" in
    true | 1 | yes)
      check_warn "DEMO_MODE" "on, every mutation is rejected"
      detail "This is the read-only public demo switch. Set DEMO_MODE=false for a real install."
      ;;
    *) check_ok "DEMO_MODE" "off" ;;
  esac

  local extra
  extra="$(unmanaged_services)"
  if [ -f "$OVERRIDE_FILE" ]; then
    check_warn "compose customization" "docker-compose.override.yml is present"
    detail "vigilctl does not load it, so this report describes a different stack from the one docker compose up builds."
  elif [ -n "$extra" ]; then
    check_warn "compose customization" "also running $extra"
    detail "Those come from an overlay docker-compose.yml does not define. vigilctl would rebuild the app and the worker and leave them behind, so it refuses to; drive this install with docker compose and both files."
  elif git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 &&
    ! git -C "$REPO" diff --quiet HEAD -- docker-compose.yml 2>/dev/null; then
    check_warn "compose customization" "docker-compose.yml has uncommitted changes"
  else
    check_ok "compose customization" "none"
  fi
}

doctor_services() {
  local service state
  for service in $STACK_SERVICES; do
    state="$(service_state "$service")"
    case "$state" in
      running) check_ok "$service" "running" ;;
      "")
        check_fail "$service" "no container"
        detail "Run: ./vigilctl install"
        ;;
      *) check_fail "$service" "$state" ;;
    esac
  done

  # The one-shot. `exited` with status 0 is the healthy state and the
  # only one: a migrate container that never ran leaves the app waiting
  # on a dependency that will not complete, and one that exited non-zero
  # is the reason the app is not up.
  state="$(service_state migrate)"
  local code
  code="$(service_exit_code migrate)"
  if [ -z "$state" ]; then
    check_fail "migrate" "never ran"
  elif [ "$state" = "running" ]; then
    check_warn "migrate" "still running"
  elif [ "$code" = "0" ]; then
    check_ok "migrate" "completed"
  else
    check_fail "migrate" "exited $code"
    detail "Read the migration output: docker compose logs migrate"
  fi
}

doctor_database() {
  if [ "$(service_state postgres)" != "running" ]; then
    check_fail "postgres" "not running, nothing below can be asked"
    return 0
  fi
  if ! postgres_ready; then
    check_fail "postgres" "pg_isready says the server is not accepting connections"
    return 0
  fi
  check_ok "postgres" "accepting connections"

  local applied on_disk
  applied="$(migrations_applied)"
  on_disk="$(migrations_on_disk)"
  if [ -z "$applied" ]; then
    check_fail "migrations" "no journal, this database has never been migrated"
    detail "Run: docker compose run --rm migrate"
  elif [ "$applied" -lt "$on_disk" ]; then
    check_fail "migrations" "$applied applied, $on_disk in this checkout"
    detail "Run: docker compose run --rm migrate"
  elif [ "$applied" -gt "$on_disk" ]; then
    # The database is ahead of the source. Usually a checkout that was
    # moved backwards without a restore, which is the state rollback
    # exists to avoid producing by accident.
    check_warn "migrations" "$applied applied, only $on_disk in this checkout"
    detail "The database was migrated by a newer version than this checkout."
  else
    check_ok "migrations" "$applied applied, up to date"
  fi
}

doctor_app() {
  if [ "$(service_state app)" != "running" ]; then
    check_fail "app health" "the app container is not running"
  elif app_ready; then
    check_ok "app health" "/api/ready returns ok"
  else
    check_fail "app health" "/api/ready did not answer ok"
    detail "Read the app output: docker compose logs app"
  fi

  if [ "$(service_state worker)" != "running" ]; then
    check_fail "worker" "the worker container is not running"
    return 0
  fi
  local age
  age="$(worker_cron_age)"
  case "$age" in
    absent)
      check_fail "worker" "the job queue schema does not exist"
      detail "The worker has never finished starting. Read: docker compose logs worker"
      ;;
    none)
      check_warn "worker" "queue installed, no scheduler pass recorded yet"
      detail "Normal for the first minute after a start. Persistent means checks are not being scheduled."
      ;;
    *)
      if [ "$age" -le "$WORKER_STALE_SECONDS" ]; then
        check_ok "worker" "last scheduler pass ${age}s ago"
      else
        check_fail "worker" "last scheduler pass ${age}s ago"
        detail "Nothing is scheduling checks. Every monitor is stale and the dashboard still shows its last status."
      fi
      ;;
  esac
}

doctor_verdict() {
  if [ "$DOCTOR_FAILURES" -gt 0 ]; then
    printf 'vigilctl: %d failure(s), %d warning(s)\n' \
      "$DOCTOR_FAILURES" "$DOCTOR_WARNINGS" >&2
    exit "$EX_FAIL"
  fi
  if [ "$DOCTOR_WARNINGS" -gt 0 ]; then
    printf 'vigilctl: healthy, with %d warning(s)\n' "$DOCTOR_WARNINGS"
    exit "$EX_NOOP"
  fi
  printf 'vigilctl: healthy\n'
  exit "$EX_OK"
}
