#!/usr/bin/env bash
#
# A `docker` that answers vigilctl without a Docker daemon.
#
# vigilctl talks to exactly one thing, and it is the slowest and least
# reproducible thing in the repository: a container runtime with a
# Postgres inside it. The behavior that has to be right, though, is not
# the containers. It is the order the steps happen in, which refusal
# fires before which destructive step, and what the exit code is. All of
# that is decidable against a stub, deterministically, in milliseconds,
# on a machine with no Docker installed at all.
#
# The real thing is exercised elsewhere: the Compose lifecycle job runs
# this CLI against real containers. This stub is for the cases that job
# cannot afford to run, and it is deliberately dumb. It answers from
# files under $STUB_STATE and appends every invocation to
# $STUB_STATE/calls, which is what the tests read.
set -uo pipefail

STATE="${STUB_STATE:?the docker stub needs STUB_STATE}"
mkdir -p "$STATE"
printf '%s\n' "$*" >>"$STATE/calls"

flag() {
  if [ -f "$STATE/$1" ]; then cat "$STATE/$1"; else printf '%s' "${2:-}"; fi
}

service_state() {
  if [ -f "$STATE/service-$1" ]; then cat "$STATE/service-$1"; else printf ''; fi
}

set_service() { printf '%s' "$2" >"$STATE/service-$1"; }

# The four questions vigilctl asks Postgres, answered from flags. The
# match is on a distinctive fragment of each statement rather than the
# whole text, so reformatting the query in the CLI does not silently
# turn every answer into the empty string.
answer_sql() {
  local sql="$1"
  case "$sql" in
    *"to_regclass('pgboss.version')"*)
      if [ "$(flag cron 5)" = "absent" ]; then echo "f"; else echo "t"; fi
      ;;
    *"from pgboss.version"*)
      local cron
      cron="$(flag cron 5)"
      case "$cron" in
        absent | none) echo "none" ;;
        *) echo "$cron" ;;
      esac
      ;;
    *"__drizzle_migrations"*) flag migrations_applied "0" && echo ;;
    *"from pg_class"*) flag tables "25" && echo ;;
    *) echo "" ;;
  esac
}

# ── docker itself ────────────────────────────────────────────────────

case "${1:-}" in
  info)
    [ "$(flag daemon 1)" = "1" ] || {
      echo "Cannot connect to the Docker daemon" >&2
      exit 1
    }
    exit 0
    ;;
  version)
    echo "28.0.0"
    exit 0
    ;;
  volume)
    [ "$(flag volume 0)" = "1" ] || exit 1
    echo "[]"
    exit 0
    ;;
  ps)
    # `docker ps`, not `docker compose ps`: the label query vigilctl uses
    # to find services running under the project that its compose file
    # does not define. One name per line, from a flag.
    for extra in $(flag extra_services ""); do echo "$extra"; done
    for base in postgres migrate app worker; do
      [ -z "$(service_state "$base")" ] || echo "$base"
    done
    exit 0
    ;;
  compose) ;;
  *) exit 0 ;;
esac

# ── docker compose ───────────────────────────────────────────────────

shift
while [ $# -gt 0 ]; do
  case "$1" in
    --project-directory | -f | -p | --env-file) shift 2 ;;
    *) break ;;
  esac
done

SUB="${1:-}"
[ $# -eq 0 ] || shift

case "$SUB" in
  version)
    [ "$(flag compose_v2 1)" = "1" ] || {
      echo "docker: 'compose' is not a docker command." >&2
      exit 1
    }
    echo "2.30.0"
    exit 0
    ;;

  ps)
    FORMAT=""
    QUIET="no"
    NAMES=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -a | --all) shift ;;
        -q | --quiet | -aq)
          QUIET="yes"
          shift
          ;;
        --format)
          FORMAT="${2:-}"
          shift 2
          ;;
        *)
          NAMES+=("$1")
          shift
          ;;
      esac
    done
    if [ "$QUIET" = "yes" ]; then
      for name in ${NAMES[@]+"${NAMES[@]}"}; do
        [ -z "$(service_state "$name")" ] ||
          printf 'cid-%s-%s\n' "$name" "$(flag generation 1)"
      done
      exit 0
    fi
    for name in ${NAMES[@]+"${NAMES[@]}"}; do
      case "$FORMAT" in
        *ExitCode*) printf '%s\n' "$(flag "exit-$name" 0)" ;;
        *) printf '%s\n' "$(service_state "$name")" ;;
      esac
    done
    exit 0
    ;;

  up)
    NAMES=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -d | --detach | --build | --wait | --remove-orphans) shift ;;
        -*) shift ;;
        *)
          NAMES+=("$1")
          shift
          ;;
      esac
    done
    # The three failures an operator meets, in the order vigilctl has to
    # tell them apart: the image does not build, the migrations fail, or
    # nothing starts at all.
    case "$(flag up_fail)" in
      build)
        echo "ERROR: failed to build: process did not complete successfully" >&2
        exit 1
        ;;
      migrate)
        set_service postgres running
        set_service migrate exited
        printf '1' >"$STATE/exit-migrate"
        echo "dependency failed to start: container vigil-migrate-1 exited (1)" >&2
        exit 1
        ;;
      start)
        echo "Error response from daemon: driver failed programming external connectivity" >&2
        exit 1
        ;;
    esac
    # Compose recreates a container when its configuration or its image
    # changed, and leaves it alone otherwise. Modelled, because that is
    # exactly what tells a repeat install (nothing changed, exit 10)
    # apart from a repair (something was down, exit 0).
    CHANGED="no"
    for name in postgres app worker; do
      [ "$(service_state "$name")" = "running" ] || CHANGED="yes"
    done
    [ "$(flag recreate 0)" = "0" ] || CHANGED="yes"
    [ "$CHANGED" = "no" ] ||
      printf '%s' "$(($(flag generation 1) + 1))" >"$STATE/generation"
    if [ "${#NAMES[@]}" -gt 0 ]; then
      for name in "${NAMES[@]}"; do set_service "$name" running; done
      exit 0
    fi
    for name in postgres app worker; do set_service "$name" running; done
    set_service migrate exited
    printf '0' >"$STATE/exit-migrate"
    exit 0
    ;;

  run)
    [ "$(flag migrate_fail 0)" = "0" ] || {
      echo "error: migration failed" >&2
      exit 1
    }
    exit 0
    ;;

  stop)
    for name in "$@"; do
      case "$name" in -* | [0-9]*) continue ;; esac
      set_service "$name" exited
    done
    exit 0
    ;;

  start)
    for name in "$@"; do set_service "$name" running; done
    exit 0
    ;;

  port)
    echo "0.0.0.0:3000"
    exit 0
    ;;

  logs) exit 0 ;;

  exec)
    while [ $# -gt 0 ]; do
      case "$1" in
        -T | -i | -t) shift ;;
        *) break ;;
      esac
    done
    SERVICE="${1:-}"
    shift || true
    TOOL="${1:-}"
    shift || true
    if [ "$(service_state "$SERVICE")" != "running" ]; then
      echo "service \"$SERVICE\" is not running" >&2
      exit 1
    fi
    case "$TOOL" in
      pg_isready) exit 0 ;;
      node)
        [ "$(flag app_ready 1)" = "1" ] || exit 1
        exit 0
        ;;
      pg_dump)
        [ "$(flag dump_fail 0)" = "0" ] || exit 1
        # A pg_dump that exits 0 having written a stream nothing can read
        # back: the redirect was cut short, the disk filled, the pipe
        # broke. The exit code says success and the file is not an
        # archive, which is the failure the validation exists for.
        if [ "$(flag dump_corrupt 0)" = "1" ]; then
          printf 'truncated\n'
          exit 0
        fi
        printf 'PGDMP-stub-archive\n'
        exit 0
        ;;
      pg_restore)
        # Listing reads the archive on standard input; anything else is
        # the restore itself, which this stub only has to not fail.
        case " $* " in
          *" --list "*)
            # Read the header out of the archive rather than piping it
            # into grep: grep -q leaves the pipe early, head dies of
            # SIGPIPE and pipefail turns a valid archive into 141.
            head_bytes="$(head -c 18)"
            case "$head_bytes" in
              PGDMP*) ;;
              *) exit 1 ;;
            esac
            printf '; Archive created by the stub\n'
            printf '1; 2615 16389 SCHEMA - public\n'
            printf '2; 1259 16390 TABLE public monitors\n'
            exit 0
            ;;
        esac
        # The three errors a --clean pass produces against pg-boss's
        # partitioned tables on every real Vigil database, with the
        # non-zero exit pg_restore gives for errors it ignored.
        if [ "$(flag restore_partition_warnings 0)" = "1" ]; then
          echo "pg_restore: error: could not execute query: ERROR:  cannot drop inherited constraint \"job_common_pkey\" of relation \"job_common\"" >&2
          echo "pg_restore: warning: errors ignored on restore: 3" >&2
          exit 1
        fi
        if [ "$(flag restore_fail 0)" = "1" ]; then
          echo "pg_restore: error: could not execute query: ERROR:  relation \"monitors\" violates constraint" >&2
          exit 1
        fi
        exit 0
        ;;
      psql)
        answer_sql "${!#}"
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;

  *) exit 0 ;;
esac
