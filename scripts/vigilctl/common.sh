# shellcheck shell=bash
#
# Exit codes, operator-facing output, redaction and consent.
#
# Sourced by `vigilctl`, never executed. Everything here is shared by
# more than one subcommand; anything used by exactly one lives with it.
#
# ── the exit codes ──────────────────────────────────────────────────
#
# Four outcomes, four numbers, because a script that wraps vigilctl has
# to be able to tell them apart and "did it print the word success" is
# not a contract. They are the same four for every subcommand:
#
#   0   success  — the command did the thing it names
#   10  no-op    — the system was already in the requested state and
#                  nothing was changed
#   20  refused  — a precondition said no. NOTHING was changed, and the
#                  reason is one line an operator can act on
#   1   failure  — it tried and did not finish. State is described in
#                  the output, and where it is not, the command says so
#   2   usage    — the arguments were wrong
#
# The distinction between 20 and 1 is the one that matters at 3am: a
# refusal is safe to ignore or override, a failure is not.

EX_OK=0
EX_FAIL=1
EX_USAGE=2
EX_NOOP=10
EX_REFUSED=20

# Set by the entrypoint from --yes.
ASSUME_YES="${ASSUME_YES:-no}"

# The terminal owns its background and text palette. Use weight for hierarchy,
# and reserve color for confirmed success or failure. Each stream decides for
# itself: redirecting stderr must not put escapes into an otherwise plain log.
# NO_COLOR and a dumb terminal disable all styling, including bold.
ui_color_enabled() {
  [ -t "$1" ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]
}

init_ui() {
  C_BOLD="" C_OK="" C_WARN="" C_FAIL="" C_OFF=""
  E_BOLD="" E_FAIL="" E_OFF=""
  if ui_color_enabled 1; then
    C_BOLD=$'\033[1m'
    C_OK=$'\033[32m'
    C_WARN="$C_BOLD"
    C_FAIL=$'\033[31m'
    C_OFF=$'\033[0m'
  fi
  if ui_color_enabled 2; then
    E_BOLD=$'\033[1m'
    E_FAIL=$'\033[31m'
    E_OFF=$'\033[0m'
  fi
}
init_ui

heading() { printf '%s%s%s\n' "$C_BOLD" "$1" "$C_OFF"; }

# How long the queue may go without a scheduler pass before the worker
# counts as dead.
#
# pg-boss stamps `pgboss.version` immediately on start and then every
# `cronMonitorIntervalSeconds`, which is 30 by default, so five minutes
# is ten missed passes. Long enough that a slow host, a clock nudge or a
# rolling restart does not raise it; short enough that a dead worker is
# reported inside one check interval of most installations.
WORKER_STALE_SECONDS=300

say() { printf '%svigilctl%s: %s\n' "$C_BOLD" "$C_OFF" "$1"; }
success() { printf '%svigilctl%s: %s%s%s\n' "$C_BOLD" "$C_OFF" "$C_OK" "$1" "$C_OFF"; }
detail() { printf '  %s\n' "$1"; }
warn() { printf '%svigilctl%s: %s\n' "$E_BOLD" "$E_OFF" "$1" >&2; }

# ── the three exits that are not success ─────────────────────────────
#
# Each takes ONE reason. Not a list: an operator reading a refusal needs
# to know what to do next, and three plausible causes is a research
# project. Where several things are wrong, the check that found them
# reports all of them and then exits through here with the first.

usage_error() {
  warn "$1"
  printf '  Run `vigilctl help` for the commands and their options.\n' >&2
  exit "$EX_USAGE"
}

refuse() {
  printf '%svigilctl: refused%s: %s\n' "$E_BOLD" "$E_OFF" "$1" >&2
  [ $# -lt 2 ] || printf '  %s\n' "$2" >&2
  exit "$EX_REFUSED"
}

die() {
  printf '%svigilctl: failed%s: %s\n' "$E_FAIL" "$E_OFF" "$1" >&2
  [ $# -lt 2 ] || printf '  %s\n' "$2" >&2
  exit "$EX_FAIL"
}

# ── redaction ────────────────────────────────────────────────────────
#
# vigilctl prints configuration on nearly every run, and a doctor report
# is the thing an operator pastes into a support thread. So no secret is
# ever printed, not once, not truncated to a prefix: a prefix of a
# 32-byte key is still key material, and the length is all a diagnosis
# needs. What the operator learns is whether the value is set and
# whether it is long enough, which is exactly what goes wrong.

redact() {
  if [ -z "${1:-}" ]; then
    printf 'not set'
  else
    printf 'set (%d characters)' "${#1}"
  fi
}

# A connection string with the password taken out but the shape left in,
# because "which host, which database, which role" is the diagnosis and
# the password never is.
redact_url() {
  printf '%s' "$1" | sed -e 's#\(://[^:/@]*\):[^@]*@#\1:***@#'
}

# ── consent ──────────────────────────────────────────────────────────
#
# Destructive commands need a human to say so. `--yes` is that human
# having said so in advance, which is how these run from a maintenance
# script; without it the operator types the word, and without a terminal
# to type into the command refuses rather than guessing.
#
# Refusing on a pipe is deliberate. The alternative is a command that
# reads EOF, treats it as consent and drops a database in a CI job that
# meant to ask a question.
confirm() {
  local word="$1" what="$2"
  if [ "$ASSUME_YES" = "yes" ]; then
    say "proceeding without asking (--yes): $what"
    return 0
  fi
  if [ ! -t 0 ]; then
    refuse "$what needs consent and there is no terminal to ask on." \
      "Re-run with --yes if that is what you mean."
  fi
  printf 'vigilctl: %s\n' "$what"
  printf '  Type %s to continue, anything else to stop: ' "$word"
  local answer=""
  read -r answer || true
  if [ "$answer" != "$word" ]; then
    refuse "not confirmed." "Nothing was changed."
  fi
}

# A UTC stamp that sorts, for filenames.
stamp() { date -u +%Y%m%dT%H%M%SZ; }

# Every path an operator gives on the command line, made absolute before
# anything uses it.
#
# `scripts/backup.sh` and `scripts/restore.sh` reach the database with
# `docker compose exec`, which resolves its project from the working
# directory, so vigilctl runs them from the repository whatever
# directory the operator is standing in. That means a relative
# `-o out.dump` or `restore ./last-night.dump` would be resolved against
# the repository instead of against where it was typed, and the archive
# would be written or looked for somewhere the operator never named.
abs_path() {
  case "$1" in
    /* | [A-Za-z]:[/\\]*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")" ;;
  esac
}
