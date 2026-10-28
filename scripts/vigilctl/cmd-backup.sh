# shellcheck shell=bash
#
# `vigilctl backup` — take a dump through the path that already exists.
#
# The whole command is `scripts/backup.sh --docker` plus the two things
# an operator would otherwise have to remember: run it from the
# repository, and check that the archive holds anything. That script
# already writes to a `.partial` name, lists the archive before renaming
# it and warns when the database was empty, which is the safe backup
# path this is required to use rather than replace.

backup_usage() {
  cat <<'TXT'
Usage: vigilctl backup [-o PATH]

Dump the database out of the running Compose stack and prove the archive
can be read back.

Options:
  -o, --output PATH   where to write (default ./backups/vigil-<utc>.dump)
  -h, --help

Exit codes: 0 written and validated, 1 failed.
TXT
}

cmd_backup() {
  local output=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -o | --output)
        output="${2:-}"
        [ -n "$output" ] || usage_error "-o needs a path"
        shift 2
        ;;
      -h | --help)
        backup_usage
        exit "$EX_OK"
        ;;
      *) usage_error "backup does not take $1" ;;
    esac
  done

  require_docker
  [ "$(service_state postgres)" = "running" ] ||
    die "the database is not running, so there is nothing to dump." \
      "Start it first: ./vigilctl install"
  postgres_ready ||
    die "the database is running but not accepting connections." \
      "./vigilctl doctor will say more."

  [ -n "$output" ] || output="$BACKUP_DIR/vigil-$(stamp).dump"
  mkdir -p "$(dirname "$output")"
  output="$(abs_path "$output")"

  # Run from the repository: backup.sh reaches the database with
  # `docker compose exec`, which resolves its project from the working
  # directory, and an operator running vigilctl from anywhere else would
  # otherwise get "no such service".
  ( cd "$REPO" && bash scripts/backup.sh --docker -o "$output" ) ||
    die "the backup did not complete." "Nothing was kept; the output above says why."

  local entries
  entries="$(archive_entries "$output")"
  if [ "$entries" = "0" ]; then
    # backup.sh already warns. Repeated here as a failure rather than a
    # warning, because a caller that asked vigilctl for a backup and got
    # exit 0 will believe it has one.
    die "the archive is readable but holds nothing." \
      "The database this dumped has no tables. Check that the stack is the one you meant: ./vigilctl doctor"
  fi

  success "backup complete"
  detail "$output ($entries archive entries)"
  detail "Restore it with: ./vigilctl restore $output"
  exit "$EX_OK"
}
