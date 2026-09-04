# Backup and restore

Vigil keeps everything it knows in one Postgres database. Back that up
and you have backed up Vigil, with the exceptions in
[What is not backed up](#what-is-not-backed-up), which are the part
worth reading twice.

Two scripts:

```bash
npm run backup                     # or: bash scripts/backup.sh
npm run restore -- <dump>          # or: bash scripts/restore.sh <dump>
```

Both take `--docker` to work through the shipped `docker-compose.yml`
stack, and `--url` / `$DATABASE_URL` to work against a database you can
reach directly.

## Taking a backup

```bash
# Shipped Docker stack
bash scripts/backup.sh --docker -o /var/backups/vigil/vigil-$(date -u +%F).dump

# Anything else
DATABASE_URL=postgresql://vigil:...@db.internal:5432/vigil \
  bash scripts/backup.sh -o /var/backups/vigil/vigil-$(date -u +%F).dump
```

With no `-o` the dump lands in `./backups/vigil-<utc timestamp>.dump`.

**It is safe to run against a live system.** `pg_dump` reads inside one
repeatable-read snapshot and takes `ACCESS SHARE` locks only, so the app
and the worker keep writing and the archive is a consistent instant
rather than a smear across the minutes the dump took. The one thing it
conflicts with is DDL: run a backup _before_ an upgrade, not during one,
or the migration and the dump will block each other.

The archive is custom format (`pg_dump -Fc`), which is what
`scripts/restore.sh` accepts. It compresses, it can be restored in
parallel, and it can be listed and restored selectively when only one
table is wrong.

### Automating it

```
# /etc/cron.d/vigil-backup, nightly at 03:17, keep 30 days
17 3 * * * root cd /opt/vigil && ./scripts/backup.sh --docker \
  -o /var/backups/vigil/vigil-$(date -u +\%FT\%H\%M\%SZ).dump \
  && find /var/backups/vigil -name 'vigil-*.dump' -mtime +30 -delete
```

The script writes to `<output>.partial` and renames only after
`pg_restore --list` has parsed what it wrote. A backup killed halfway
therefore leaves no file that looks finished, which matters more for a
cron job nobody watches than for one you run by hand.

## What is backed up

Everything in the database, which is everything Vigil persists:

| Data                                                    | In the dump |
| ------------------------------------------------------- | ----------- |
| Monitors, their configuration and schedule              | yes         |
| Check history (`monitor_checks`) and the ledger columns | yes         |
| Incidents and their timelines                           | yes         |
| Status pages, components and confirmed subscribers      | yes         |
| Escalation policies, steps and on-call schedules        | yes         |
| Recovery actions and attempts                           | yes         |
| Notification outbox, including messages still queued    | yes         |
| Users, organizations, memberships, invitations          | yes         |
| Password hashes and live sessions                       | yes         |
| Audit log                                               | yes         |
| The migration journal (`drizzle.__drizzle_migrations`)  | yes         |
| pg-boss job queue tables                                | yes         |

The migration journal matters: a restored database knows which
migrations it has already had, so `npm run db:migrate` afterwards is a
no-op rather than an attempt to replay all of them.

## What a dump contains, and what is in the clear

A dump is a credential file. Treat it as one.

**Notification channel secrets are encrypted** (AES-256-GCM, under a key
derived from `BETTER_AUTH_SECRET`), so a Slack webhook or an SMTP
password in the archive is ciphertext. The key lives in `.env`, which
the next section says to store somewhere the dump is not. That
separation is the whole of what the encryption buys.

**Monitor credentials are not encrypted.** A Redis password in
`monitors.config`, and a `postgres://user:password@host/db` target in
`monitors.url`, are stored as they were typed. This is deliberate, and
the reasoning is written down here because the asymmetry looks like an
oversight:

- **The target cannot be encrypted.** It is the address the probe
  dials, it is rendered on the monitor page, and it is what a check
  type is addressed by. Encrypting `config` while `url` stayed readable
  would produce a half-story whose boundary no operator could be
  expected to know: true for a Redis monitor, false for a Postgres one,
  and describable only in a sentence that is wrong half the time.
- **It would not survive the credential's own life.** The secret is
  sent to remote probe agents on every poll and then presented on the
  wire to protocols that are not confidential by design. RADIUS
  authenticates with MD5, SQL Server's login packet is a nibble swap
  and an XOR, and the FTP, IMAP, SMTP and memcached probes are
  plaintext throughout. Vigil's own docs say so where each is
  documented.
- **It would not survive an application compromise.** The key is
  derived from a secret the same process reads out of the same `.env`.
  Anything that can run as Vigil can decrypt. There is no KMS and no
  operator passphrase, and adding one would mean the worker could not
  start unattended, which is not a trade a monitoring product can make.

So the honest boundary is the archive, not the column. Encrypt the dump
or put it somewhere already encrypted, and give a monitor an account
scoped to what the check needs: a Postgres monitor needs to connect, it
does not need to read your tables.

What Vigil does instead is make sure the credential does not travel.
The target is stripped of its userinfo everywhere it is displayed,
logged, exported or sent to a channel, and the config blob's declared
secrets are replaced by a sentinel before anything crosses into a
browser. Encryption at rest is claimed only for notification channels,
and a test keeps that claim scoped so it cannot quietly widen into one
about monitors.

## What is NOT backed up

**Everything outside Postgres.** These are not in the dump and a restore
will not bring them back:

- **`.env` and every secret in it.** `BETTER_AUTH_SECRET` above all:
  sessions and reset tokens are signed with it, and restoring a database
  under a different secret silently signs out every user and invalidates
  every outstanding password-reset link. `DATABASE_URL`, `RESEND_API_KEY`,
  `ANTHROPIC_API_KEY`, `POSTGRES_PASSWORD` and every other credential the
  deployment sets are in the same file and the same position. Back it up
  separately, somewhere a database dump is not.
- **Roles, ownership and grants.** The dump is taken with `--no-owner
--no-privileges` on purpose: the shipped stack connects as `vigil` and a
  local install usually as `postgres`, and an archive that names a role
  refuses to restore where that role does not exist. Vigil creates no
  roles and no grants of its own, so nothing real is lost, but if _you_
  added any, they are yours to recreate.
- **Anything else in the same cluster.** The dump is one database, not the
  server. Other databases, and cluster-level settings, are not in it.
- **TLS certificates, reverse-proxy configuration, the Docker images
  themselves.** Rebuilt from the repository and your deployment config,
  not from here.
- **Your customizations**, if you have not committed them. See
  [UPGRADE.md](UPGRADE.md).

## Restoring

`scripts/restore.sh` **refuses to run against a database that already
holds tables.**

That is the reason the script exists. `pg_restore`'s default is to
create what is missing, log an error for everything that already exists,
and exit 0, so restoring last week's backup over a live database leaves
every current row in place, adds nothing, and reports success. You find
out which of the two databases you are looking at some time later, from
a customer.

```bash
# 1. Stop the app and the worker. Both hold connections and the worker
#    writes new checks continuously.
docker compose stop app worker

# 2. Restore into an empty database.
docker compose exec -T postgres psql -U vigil -d postgres \
  -c 'DROP DATABASE vigil;' -c 'CREATE DATABASE vigil OWNER vigil;'
bash scripts/restore.sh --docker /var/backups/vigil/vigil-2026-08-01.dump

# 3. Bring the schema up to the build you are running. A no-op when the
#    dump came from this version; the whole point when it did not.
docker compose run --rm migrate

# 4. Start again.
docker compose up -d app worker
```

`--force` is the deliberate override: it adds `--clean --if-exists`, so
each object is dropped before it is recreated and the contents really are
replaced. It is still not a merge. Nothing here can merge two databases,
and a flag that pretended to would be the same failure in nicer clothes.

The archive is validated before anything is dropped, so a `--force` run
against a corrupt or truncated file fails with the database untouched.

## Verifying that a backup is restorable

A backup you have never restored is a hypothesis. Test it the only way
that settles it: restore it somewhere else and count.

```bash
# 1. Cheapest check, the archive parses and has a table of contents.
pg_restore --list vigil-2026-08-01.dump | head

# 2. Restore into a scratch database that nothing is using.
createdb -h localhost -p 5432 -U postgres vigil_restore_check
DATABASE_URL=postgresql://postgres@localhost:5432/vigil_restore_check \
  bash scripts/restore.sh vigil-2026-08-01.dump

# 3. Row counts per table.
psql postgresql://postgres@localhost:5432/vigil_restore_check <<'SQL'
select table_name,
       (xpath('/row/cnt/text()', xml_count))[1]::text::bigint as rows
from (
  select table_name,
         query_to_xml(format('select count(*) as cnt from %I.%I',
                             table_schema, table_name), false, true, '') as xml_count
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
) t
order by table_name;
SQL

# 4. A value, not just a count, content, in order, hashed.
psql postgresql://postgres@localhost:5432/vigil_restore_check -tAc \
  "select md5(string_agg(id::text||name||coalesce(url,''), '|' order by id))
   from monitors;"

# 5. Throw it away.
dropdb -h localhost -p 5432 -U postgres vigil_restore_check
```

Run step 4 against the live database too. Two identical hashes are the
proof; two identical row counts are only an encouraging sign, because a
column restored as nulls counts the same as one restored correctly.

A real run of exactly this against a seeded scratch database, with the
dump path and the hash query shortened for width:

```
$ bash scripts/backup.sh -o proof.dump
backup: dumping localhost:5433/vigil_backup_proof
backup: wrote proof.dump (188K, 171 archive entries)

$ psql .../vigil_backup_proof -tAc "select md5(string_agg(…)) from monitors;"
e071a10e2ff87b2a2f1613082bdf7bdb

$ psql .../postgres -c 'DROP DATABASE vigil_backup_proof;' \
                    -c 'CREATE DATABASE vigil_backup_proof;'
DROP DATABASE
CREATE DATABASE

$ bash scripts/restore.sh proof.dump
restore: restoring proof.dump into localhost:5433/vigil_backup_proof
restore: done. Verify before you trust it:

$ psql .../vigil_backup_proof -tAc "select md5(string_agg(…)) from monitors;"
e071a10e2ff87b2a2f1613082bdf7bdb          # identical
```

Row counts across all 25 tables matched, `monitor_checks` among them at
8945 rows, and `drizzle.__drizzle_migrations` came back with all 17 rows,
so `db:migrate` afterwards was a no-op, which is the point of the
journal being in the dump.

Three more properties, proved the same way and worth knowing before you
need them:

- **The `--docker` path is the same path.** The same cycle run against
  the shipped Compose stack, `backup.sh --docker`, drop and recreate
  `vigil` inside the container, `restore.sh --docker`: came back with an
  identical hash and all 8945 check rows.
- **A corrupt archive costs nothing.** `restore.sh --force` pointed at a
  file that is not an archive refused, with the target database
  untouched: validation happens before anything is dropped.
- **`--force` replaces, it does not merge.** A row written after the
  backup was gone afterwards, and the hash matched the archive rather
  than the database it overwrote.

## After a restore

- **Sessions.** They are in the dump, so people restored from an old
  backup may be signed in with sessions that pre-date it. That is
  harmless, unless `BETTER_AUTH_SECRET` changed, in which case every one
  of them is invalid and everybody signs in again.
- **The outbox.** Messages that were `queued` when the backup was taken
  are queued again, and the worker will send them. Incident notifications
  from the restored window will therefore go out a second time, expected,
  and the idempotency key stops it happening more than once from here.
- **Monitor scheduling.** `monitors.next_evaluation_at` is restored as it
  was, so every monitor whose slot has passed is checked shortly after the
  worker starts. A brief burst, then normal cadence.
- **Check history has a hole** for the window between the backup and the
  restore. Uptime is duration-weighted (see [UPTIME.md](UPTIME.md)), so
  that hole reads as _uncovered_ time and is reported separately rather
  than being averaged in as either up or down.
