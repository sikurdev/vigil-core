# shellcheck shell=bash
#
# `vigilctl rollback` — undo the last update.
#
# Two things move back, together: the checkout, to the commit that was
# installed before, and the database, to the dump taken before the
# migrations ran. Neither is enough alone. Putting the old code on a
# database a new migration has already changed is the state this exists
# to avoid, not to produce.
#
# There are no down-migrations and there will not be. Vigil migrations
# are forward-only and always have been: they are ordered files, upstream
# never rewrites one, and several of them are not reversible in principle
# (a column that was dropped cannot be un-dropped from a script that does
# not have the values). A generated `down` would be a file that runs,
# reports success and leaves a schema nobody has ever tested. The dump is
# the reverse, and it is a real one.
#
# What that costs is stated plainly and cannot be avoided: anything
# written after the update is not in the dump, so a rollback loses it.
# The confirmation says so in those words.

rollback_usage() {
  cat <<'TXT'
Usage: vigilctl rollback [OPTIONS]

Return to the version and the database that were installed before the
last vigilctl update.

This is destructive. The database goes back to the dump taken before the
update, so anything written since then is lost. Migrations are
forward-only: nothing is un-applied, the pre-update database is put back
whole.

Options:
      --yes                 do not ask for confirmation
      --allow-customized    proceed even though this is not the stock stack
      --timeout SECONDS     how long to wait for health (default 300)
  -h, --help

Exit codes: 0 rolled back and healthy, 20 refused (nothing to roll back,
or the record is unusable), 1 failed.
TXT
}

cmd_rollback() {
  local allow_customized="no" timeout=300
  while [ $# -gt 0 ]; do
    case "$1" in
      --allow-customized)
        allow_customized="yes"
        shift
        ;;
      --timeout)
        timeout="${2:-}"
        shift 2
        ;;
      -h | --help)
        rollback_usage
        exit "$EX_OK"
        ;;
      *) usage_error "rollback does not take $1" ;;
    esac
  done
  case "$timeout" in
    '' | *[!0-9]*) usage_error "--timeout takes a number of seconds" ;;
  esac

  require_docker
  assert_stock_stack "$allow_customized"

  [ -f "$ROLLBACK_STATE" ] ||
    refuse "there is no update to roll back." \
      "vigilctl update writes the record this reads. To go back to an arbitrary version, use ./vigilctl update --to <ref> and ./vigilctl restore <archive>."

  local from_sha from_ref to_ref dump
  from_sha="$(state_get from_sha)"
  from_ref="$(state_get from_ref)"
  to_ref="$(state_get to_ref)"
  dump="$(state_get dump)"

  [ -n "$from_sha" ] && [ -n "$dump" ] ||
    refuse "the rollback record at $ROLLBACK_STATE is incomplete." \
      "Nothing was changed. Roll back by hand: git checkout <old ref> and ./vigilctl restore <archive>."

  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    refuse "$REPO is not a git checkout, so the code cannot be moved back." \
      "Nothing was changed."
  git -C "$REPO" cat-file -e "${from_sha}^{commit}" 2>/dev/null ||
    refuse "the commit this install was on ($from_sha) is not in this checkout any more." \
      "Nothing was changed. Fetch it, or roll back by hand."
  if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
    refuse "this checkout has uncommitted changes to tracked files." \
      "A rollback checks out $from_sha and would overwrite them. Commit or stash them first."
  fi

  # Before the database is touched, as everywhere else in this CLI: an
  # unreadable archive must cost nothing.
  if [ "$(service_state postgres)" != "running" ]; then
    say "starting the database"
    compose up -d postgres >/dev/null 2>&1 ||
      die "could not start Postgres." "Nothing was changed."
    wait_for "postgres" 120 postgres_ready ||
      die "Postgres never started accepting connections." "Nothing was changed."
  fi
  [ -r "$dump" ] ||
    refuse "the pre-update dump named in the record is gone ($dump)." \
      "Nothing was changed. Without it a rollback would put old code on a migrated database."
  archive_lists "$dump" ||
    refuse "the pre-update dump at $dump cannot be read back." \
      "Nothing was changed."

  say "rolling back"
  detail "code:     $(short_sha "$from_sha")${from_ref:+ (branch $from_ref)}, from $to_ref"
  detail "database: $dump"

  confirm "rollback" \
    "this returns the code and the database to where they were before the update, and anything written since is lost"

  local safety
  safety="$(safety_dump pre-rollback)"
  [ -z "$safety" ] || say "the database as it is now: $safety"

  say "stopping the app and the worker"
  compose stop app worker >/dev/null 2>&1 || true

  # The checkout moves first, so the images that get built below are the
  # old ones. A restore under the new code, even briefly, is a worker
  # writing rows the old schema does not have.
  say "checking out the previous version"
  local target="$from_sha"
  if [ -n "$from_ref" ] &&
    [ "$(git -C "$REPO" rev-parse --verify --quiet "$from_ref" || true)" = "$from_sha" ]; then
    target="$from_ref"
  fi
  git -C "$REPO" checkout --quiet "$target" ||
    rollback_failed "$safety" "git could not check out $target."

  say "restoring the pre-update database"
  ( cd "$REPO" && bash scripts/restore.sh --docker --force "$dump" ) ||
    rollback_failed "$safety" "the pre-update dump did not restore cleanly."

  say "building and starting the previous version"
  compose up -d --build ||
    rollback_failed "$safety" "the previous version did not build or start."

  wait_for "app health" "$timeout" app_ready ||
    rollback_failed "$safety" "the app never answered /api/ready within ${timeout}s."
  wait_for "worker" "$timeout" worker_live ||
    rollback_failed "$safety" "the worker never recorded a scheduler pass within ${timeout}s."

  # Consumed rather than deleted. The record names a dump that still
  # exists and an operator may want to read it; what it must not do is
  # let a second rollback run against a state that has already been
  # applied.
  mv "$ROLLBACK_STATE" "$ROLLBACK_STATE.done-$(stamp)"

  say "rolled back to $(short_sha "$from_sha")"
  [ -z "$safety" ] || detail "The database this replaced is at $safety."
  exit "$EX_OK"
}

state_get() {
  sed -n "s/^$1=//p" "$ROLLBACK_STATE" 2>/dev/null |
    awk '{ last = $0 } END { if (NR) print last }'
}

short_sha() { git -C "$REPO" rev-parse --short "$1" 2>/dev/null || printf '%s' "$1"; }

rollback_failed() {
  local safety="$1" reason="$2"
  printf 'vigilctl: failed: %s\n' "$reason" >&2
  printf '  The rollback record is kept, so this command can be run again.\n' >&2
  if [ -n "$safety" ]; then
    printf '  The database as it was before this command is at %s\n' "$safety" >&2
  fi
  printf '  ./vigilctl doctor will say what state the stack is in now.\n' >&2
  exit "$EX_FAIL"
}
