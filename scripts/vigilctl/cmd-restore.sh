# shellcheck shell=bash
#
# `vigilctl restore` — put an archive back, and prove the stack works
# afterwards.
#
# The order of this command is the whole of it, because every step that
# can refuse comes before every step that destroys:
#
#   1. the archive is readable, and holds something
#   2. the operator says so, in a word or with --yes
#   3. the current database is dumped, so this is itself reversible
#   4. app and worker stop, because both write continuously
#   5. scripts/restore.sh --force replaces the contents
#   6. the migrate job brings the schema up to the running build
#   7. everything starts, and health is waited for rather than assumed
#
# Steps 1 and 2 cannot change anything. Step 3 is what makes a restore
# of the wrong archive survivable, and the path is printed twice: once
# when it is taken and once in every failure below it.

restore_usage() {
  cat <<'TXT'
Usage: vigilctl restore ARCHIVE [OPTIONS]

Replace the database contents with an archive taken by vigilctl backup,
then bring the stack back up and verify it.

This is destructive. Everything written since the archive was taken is
gone. A dump of the current database is taken first and its path is
printed, so the restore itself can be undone.

Options:
      --yes                 do not ask for confirmation
      --allow-customized    proceed even though this is not the stock stack
      --timeout SECONDS     how long to wait for health (default 300)
  -h, --help

Exit codes: 0 restored and healthy, 20 refused, 1 failed.
TXT
}

cmd_restore() {
  local archive="" allow_customized="no" timeout=300
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
        restore_usage
        exit "$EX_OK"
        ;;
      -*) usage_error "restore does not take $1" ;;
      *)
        [ -z "$archive" ] || usage_error "restore takes one archive (got $archive and $1)"
        archive="$1"
        shift
        ;;
    esac
  done
  [ -n "$archive" ] || usage_error "restore needs an archive: vigilctl restore ARCHIVE"
  case "$timeout" in
    '' | *[!0-9]*) usage_error "--timeout takes a number of seconds" ;;
  esac

  require_docker
  assert_stock_stack "$allow_customized"
  [ -r "$archive" ] ||
    die "cannot read $archive." "Check the path and the permissions."
  archive="$(abs_path "$archive")"

  # Validation needs a pg_restore, and on a host without the client
  # tools that means the container. Starting the database on its own is
  # not destructive and is required for the restore regardless, so it
  # happens here, before consent, rather than after it.
  if [ "$(service_state postgres)" != "running" ]; then
    say "starting the database (needed to read the archive)"
    compose up -d postgres >/dev/null 2>&1 ||
      die "could not start Postgres." "./vigilctl doctor will say more."
    wait_for "postgres" 120 postgres_ready ||
      die "Postgres never started accepting connections." \
        "Read its output: docker compose logs postgres"
  fi

  archive_lists "$archive" ||
    die "$archive is not a custom-format pg_dump archive." \
      "Nothing was changed. scripts/backup.sh writes one; a plain .sql file is replayed with psql."
  local entries
  entries="$(archive_entries "$archive")"
  if [ "$entries" = "0" ]; then
    refuse "$archive parses but holds no objects." \
      "Restoring it would empty this installation. Nothing was changed."
  fi
  say "archive: readable, $entries entries"

  confirm "restore" \
    "this replaces the contents of the live database with $archive, and everything written since it was taken is lost"

  local safety
  safety="$(safety_dump pre-restore)"
  if [ -n "$safety" ]; then
    say "the database as it is now: $safety"
  else
    say "the database holds no tables, so there was nothing to save first"
  fi

  # Both write continuously. Restoring underneath them races the restore
  # against new rows for the same monitors.
  say "stopping the app and the worker"
  compose stop app worker >/dev/null 2>&1 || true

  say "restoring"
  if ! ( cd "$REPO" && bash scripts/restore.sh --docker --force "$archive" ); then
    restore_failed "$safety" "pg_restore did not finish cleanly."
  fi

  # Forward-only, and this is where that shows: an archive from an older
  # release restores into a newer checkout and the missing migrations are
  # applied on top. The journal is inside the dump, so an archive from
  # this build makes this a no-op.
  say "bringing the schema up to this build"
  if ! compose run --rm migrate; then
    restore_failed "$safety" "the migrations failed against the restored database."
  fi

  say "starting the app and the worker"
  compose up -d >/dev/null 2>&1 ||
    restore_failed "$safety" "the stack did not start after the restore."

  wait_for "app health" "$timeout" app_ready ||
    restore_failed "$safety" "the app never answered /api/ready within ${timeout}s."
  wait_for "worker" "$timeout" worker_live ||
    restore_failed "$safety" "the worker never recorded a scheduler pass within ${timeout}s."

  say "restored"
  detail "$archive is now the contents of this installation."
  [ -z "$safety" ] || detail "The database it replaced is at $safety."
  exit "$EX_OK"
}

# Every failure after the point of no return says the same two things:
# what broke, and where the database it replaced still is. An operator
# reading this at 3am should not have to scroll for the second one.
restore_failed() {
  local safety="$1" reason="$2"
  printf 'vigilctl: failed: %s\n' "$reason" >&2
  if [ -n "$safety" ]; then
    printf '  The database as it was before this command is at %s\n' "$safety" >&2
    printf '  Put it back with: ./vigilctl restore %s\n' "$safety" >&2
  fi
  printf '  ./vigilctl doctor will say what state the stack is in now.\n' >&2
  exit "$EX_FAIL"
}
