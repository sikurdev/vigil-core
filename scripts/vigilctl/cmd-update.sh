# shellcheck shell=bash
#
# `vigilctl update` — move the install to a version the operator names.
#
# Named, always. There is no `vigilctl update` that picks something for
# you and no channel to follow: a monitoring system that upgrades itself
# is a monitoring system that can go down at 4am for a reason nobody
# chose. `--to` is required, it is not defaulted, and a `--to` that
# resolves to what is already installed is a no-op rather than a
# rebuild.
#
# The sequence, and the reason it is this sequence:
#
#   preflight   a stack that is already broken cannot tell you whether
#               the update broke it
#   backup      taken and validated BEFORE anything moves, because it is
#               the only thing that makes the next four steps reversible
#   record      what to go back to, written to disk, because the shell
#               that knew it is the shell that is about to fail
#   checkout    the operator version
#   build       images, then the migrate job, then app and worker
#   verify      real health, not "docker says it started"
#
# Nothing here rolls back on its own. A failed update leaves the stack
# where it stopped and prints the one command that undoes it, because
# automatic recovery from a state nobody has looked at is how a bad
# upgrade becomes a bad upgrade plus a lost database.

update_usage() {
  cat <<'TXT'
Usage: vigilctl update --to REF [OPTIONS]

Move this install to a named version: preflight, verified backup, build,
migrate, restart, verify.

Options:
      --to REF              tag, branch or commit to install. Required.
      --fetch               git fetch --tags first, so a new tag resolves
      --yes                 do not ask for confirmation
      --allow-customized    proceed even though this is not the stock stack
      --timeout SECONDS     how long to wait for health (default 300)
  -h, --help

Exit codes: 0 updated and healthy, 10 already on that version,
20 refused, 1 failed (run vigilctl rollback).
TXT
}

cmd_update() {
  local to="" fetch="no" allow_customized="no" timeout=300
  while [ $# -gt 0 ]; do
    case "$1" in
      --to)
        to="${2:-}"
        [ -n "$to" ] || usage_error "--to needs a tag, branch or commit"
        shift 2
        ;;
      --fetch)
        fetch="yes"
        shift
        ;;
      --allow-customized)
        allow_customized="yes"
        shift
        ;;
      --timeout)
        timeout="${2:-}"
        shift 2
        ;;
      -h | --help)
        update_usage
        exit "$EX_OK"
        ;;
      *) usage_error "update does not take $1" ;;
    esac
  done
  case "$timeout" in
    '' | *[!0-9]*) usage_error "--timeout takes a number of seconds" ;;
  esac

  require_docker
  assert_stock_stack "$allow_customized"
  require_git_checkout

  if [ -z "$to" ]; then
    printf 'vigilctl: refused: no version chosen.\n' >&2
    printf '  vigilctl never picks one for you. Installed now:\n' >&2
    printf '    %s\n' "$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null)" >&2
    printf '  Recent tags in this checkout:\n' >&2
    git -C "$REPO" tag --sort=-v:refname |
      awk 'NR<=5 { printf "    %s\n", $0 }' >&2 || true
    printf '  Then: ./vigilctl update --to <tag>\n' >&2
    exit "$EX_REFUSED"
  fi

  if [ "$fetch" = "yes" ]; then
    say "fetching"
    git -C "$REPO" fetch --tags --quiet ||
      die "git fetch failed." "Nothing was changed."
  fi

  local to_sha from_sha from_ref
  to_sha="$(git -C "$REPO" rev-parse --verify --quiet "${to}^{commit}" || true)"
  [ -n "$to_sha" ] ||
    refuse "$to is not a tag, branch or commit in this checkout." \
      "Run ./vigilctl update --fetch --to $to if it is a new tag on the remote."
  from_sha="$(git -C "$REPO" rev-parse HEAD)"
  from_ref="$(git -C "$REPO" symbolic-ref --quiet --short HEAD || true)"

  # ── already there, or half way there ───────────────────────────────
  #
  # The checkout being at the target is not on its own evidence that the
  # update happened: an update interrupted between the checkout and the
  # build leaves exactly that, with the old images still running. So the
  # record decides. A completed update to this commit means there is
  # nothing to do; a started one means finish it.
  #
  # And "finish it" must not start over. A second pass through the fresh
  # path would take a backup of the half-migrated database and overwrite
  # the record with from_sha = the version being installed, which is the
  # one thing that would make the way back unreachable.
  local resuming="no"
  if [ "$to_sha" = "$from_sha" ]; then
    if update_unfinished "$to_sha"; then
      resuming="yes"
      say "the checkout is at $to and the last update to it did not finish"
      detail "resuming it; the backup and the way back are the ones it already recorded"
    else
      say "already on $to ($(short "$to_sha")), nothing to do"
      exit "$EX_NOOP"
    fi
  fi

  local dump
  if [ "$resuming" = "yes" ]; then
    dump="$(state_field dump)"
    confirm "update" \
      "this finishes the update to $to that was interrupted, and restarts the stack"
  else
    say "preflight"
    stack_healthy ||
      refuse "this install is not healthy, so an update could not be told apart from what is already wrong." \
        "Run ./vigilctl doctor, fix what it names, then update."
    detail "current: $(git -C "$REPO" describe --tags --always) ($(short "$from_sha"))"
    detail "target:  $to ($(short "$to_sha"))"

    confirm "update" \
      "this rebuilds the images, applies any new migrations and restarts the stack"

    # Before anything moves. The archive is validated by the backup path
    # itself, and a backup that cannot be taken stops the update here,
    # where stopping costs nothing.
    say "taking a verified backup"
    dump="$BACKUP_DIR/pre-update-$(stamp).dump"
    mkdir -p "$BACKUP_DIR"
    (cd "$REPO" && bash scripts/backup.sh --docker -o "$dump") ||
      die "could not take a backup, so the update did not start." \
        "Nothing was changed. Fix the backup path first: ./vigilctl backup"
    archive_lists "$dump" ||
      die "the backup that was just taken cannot be read back." \
        "Nothing was changed."
    detail "$dump"

    write_rollback_state "$from_sha" "$from_ref" "$to" "$to_sha" "$dump"

    say "checking out $to"
    git -C "$REPO" checkout --quiet "$to" ||
      die "git could not check out $to." \
        "Nothing else was changed. The stack is still running the old build."
  fi

  say "building and starting"
  local log
  log="$(mktemp -t vigilctl-update.XXXXXX)"
  if ! compose up -d --build 2>&1 | tee "$log"; then
    rm -f "$log"
    update_failed "the new version did not build, migrate or start."
  fi
  rm -f "$log"

  wait_for "app health" "$timeout" app_ready ||
    update_failed "the app never answered /api/ready within ${timeout}s on the new version."
  wait_for "worker" "$timeout" worker_live ||
    update_failed "the worker never recorded a scheduler pass within ${timeout}s on the new version."

  # Only now. Everything above can be interrupted, and the difference
  # between "the checkout moved" and "the update happened" is this line.
  # Appended rather than rewritten: `state_field` reads the last
  # assignment, and a torn append leaves the record unfinished, which is
  # the safe direction to fail in.
  printf 'stage=complete\n' >>"$ROLLBACK_STATE"

  say "updated to $to ($(short "$to_sha"))"
  detail "The database as it was before this update is at $dump"
  detail "If this version misbehaves: ./vigilctl rollback"
  exit "$EX_OK"
}

# The last value assigned to a key in the rollback record, or nothing.
state_field() {
  [ -f "$ROLLBACK_STATE" ] || return 0
  sed -n "s/^$1=//p" "$ROLLBACK_STATE" |
    awk '{ last = $0 } END { if (NR) print last }'
}

# True when the record describes an update to this commit that never
# reported success.
update_unfinished() {
  [ -f "$ROLLBACK_STATE" ] || return 1
  [ "$(state_field to_sha)" = "$1" ] || return 1
  [ "$(state_field stage)" != "complete" ]
}

# Everything after the checkout fails through here, because the operator
# needs the same two facts every time: what broke, and the one command
# that puts it back.
update_failed() {
  printf 'vigilctl: failed: %s\n' "$1" >&2
  printf '  The stack is part way through an update. Nothing has been undone.\n' >&2
  printf '  Put it back: ./vigilctl rollback\n' >&2
  printf '  Or read what happened first: docker compose logs migrate app worker\n' >&2
  exit "$EX_FAIL"
}

require_git_checkout() {
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    refuse "$REPO is not a git checkout, so there is no version to move between." \
      "Updates are taken by moving a git checkout. Re-deploy from a clone of the source you were given."
  # Tracked files only. `.env`, `backups/` and whatever else the operator
  # keeps beside the checkout are untracked and none of this business.
  if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]; then
    refuse "this checkout has uncommitted changes to tracked files." \
      "An update checks out another version and would overwrite or refuse partway. Commit or stash them first: git -C $REPO status"
  fi
}

short() { git -C "$REPO" rev-parse --short "$1" 2>/dev/null || printf '%s' "$1"; }

# ── the rollback record ──────────────────────────────────────────────
#
# On disk, not in a variable, because the process that knows what to go
# back to is the process that is about to fail. Written into backups/,
# which is already excluded from git and is where the dump it names
# lives, so the two travel together.
write_rollback_state() {
  local from_sha="$1" from_ref="$2" to="$3" to_sha="$4" dump="$5" tmp
  mkdir -p "$BACKUP_DIR"
  tmp="$(mktemp "$ROLLBACK_STATE.XXXXXX")"
  {
    printf 'version=1\n'
    printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'from_sha=%s\n' "$from_sha"
    printf 'from_ref=%s\n' "$from_ref"
    printf 'to_ref=%s\n' "$to"
    printf 'to_sha=%s\n' "$to_sha"
    printf 'dump=%s\n' "$dump"
    # Flipped to `complete` by an append at the very end of a successful
    # run. Until then this record describes an update that is in flight,
    # which is what lets a re-run finish it rather than start it again.
    printf 'stage=started\n'
  } >"$tmp"
  mv "$tmp" "$ROLLBACK_STATE"
}
