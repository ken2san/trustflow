# scripts/lib/local-db-guard.sh — sourced, not run.
#
# Decides whether a script that writes PERMANENT rows (`events` is append-only)
# may connect to a database, and confirms it connected where it meant to.
#
# WHY IT IS THIS STRICT
# The first version matched a loopback substring in the URL. Codex (Task 76)
# showed that is not the target libpq actually connects to: a loopback
# authority plus a `?host=`/`?hostaddr=` override, a `service=`, a second host
# in a comma list, or a PG* environment variable can all send the connection
# somewhere else while the string still "looks local". So:
#
#   1. Only one URL shape is accepted, parsed by a single anchored pattern:
#        postgres[ql]://USER[:PASSWORD]@127.0.0.1|[::1]:PORT/DBNAME
#      No query string, no commas, no percent-encoding, no hostnames (so no
#      DNS, not even `localhost`). Anything else is refused, not repaired.
#   2. The URL is never handed to libpq. A keyword conninfo is rebuilt from the
#      parsed parts, so what connects is exactly what was validated.
#   3. Any PG* or PSQL* environment variable is refused outright, and psql is
#      run with -X (no psqlrc).
#   4. After connecting and BEFORE any write, the server itself must report a
#      loopback address, carry the opt-in marker below, and show neither
#      Supabase project ref in what it reports about itself.
#
# THE MARKER is a database setting the operator puts on a disposable database
# once, by hand; no hosted database will ever carry it by accident:
#
#   alter database postgres set trustflow.disposable_race_db = 'yes';
#
# The decisions are pure functions (no connection), so every rejection path is
# exercised by `guard_self_check` without touching any database.

GUARD_REFS='fqgpzhwvvfsxswlnbbgg yqjtawffpesplqyurlpj'

# parse_local_db_url URL — on success sets DB_USER DB_PASS DB_HOST DB_PORT
# DB_NAME and returns 0; otherwise prints the reason and returns 1.
parse_local_db_url() {
  local url="$1"
  local re='^postgres(ql)?://([A-Za-z0-9._-]+)(:([A-Za-z0-9._~-]*))?@(127\.0\.0\.1|\[::1\]):([0-9]{1,5})/([A-Za-z0-9_-]+)$'
  if [[ ! "$url" =~ $re ]]; then
    echo "not postgres[ql]://user[:password]@127.0.0.1|[::1]:port/dbname with no query, list or encoding"
    return 1
  fi
  DB_USER="${BASH_REMATCH[2]}"
  DB_PASS="${BASH_REMATCH[4]}"
  DB_HOST="${BASH_REMATCH[5]}"
  DB_PORT="${BASH_REMATCH[6]}"
  DB_NAME="${BASH_REMATCH[7]}"
  [ "$DB_HOST" = "[::1]" ] && DB_HOST="::1"
  if [ "$DB_PORT" -lt 1 ] || [ "$DB_PORT" -gt 65535 ]; then
    echo "port out of range"
    return 1
  fi
  return 0
}

# refuse_redirecting_env — every PG*/PSQL* variable, set to anything. Listing
# the dangerous ones (PGHOST, PGHOSTADDR, PGSERVICE, PGSERVICEFILE,
# PGSYSCONFDIR, PGOPTIONS, PGTARGETSESSIONATTRS, …) would be a list to keep
# current; refusing the prefix is not.
refuse_redirecting_env() {
  local found
  found="$(env | grep -oE '^(PG|PSQL)[A-Za-z0-9_]*=' | tr -d '=' | tr '\n' ' ' || true)"
  if [ -n "$found" ]; then
    echo "unset these first, they can change where libpq connects: $found"
    return 1
  fi
  return 0
}

# judge_server ADDR MARKER FINGERPRINT — what the connected server said about
# itself. ADDR is host(inet_server_addr()) or 'socket' when it is NULL; a NULL
# is refused because the conninfo forces TCP, so a socket answer means the
# connection is not the one that was built.
judge_server() {
  local addr="$1" marker="$2" fingerprint="$3" ref
  case "$addr" in
    127.*|::1) ;;
    *) echo "server address is '$addr', not loopback"; return 1 ;;
  esac
  if [ "$marker" != "yes" ]; then
    echo "trustflow.disposable_race_db is not 'yes' on this database (see scripts/lib/local-db-guard.sh)"
    return 1
  fi
  for ref in $GUARD_REFS; do
    case "$fingerprint" in
      *"$ref"*) echo "server reports project ref $ref"; return 1 ;;
    esac
  done
  return 0
}

# guard_self_check — every rejection path, no connection made.
guard_self_check() {
  local fails=0 url why
  local bad=(
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.yqjtawffpesplqyurlpj.supabase.co'
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres?hostaddr=10.0.0.5'
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres?service=prod'
    'postgresql://postgres@127.0.0.1:54322,db.fqgpzhwvvfsxswlnbbgg.supabase.co:5432/postgres'
    'postgresql://postgres:p@127.0.0.1:1@db.fqgpzhwvvfsxswlnbbgg.supabase.co:5432/postgres'
    'postgresql://postgres:postgres@localhost:54322/postgres'
    'postgresql://postgres:postgres@db.yqjtawffpesplqyurlpj.supabase.co:5432/postgres'
    'postgresql://postgres:postgres@127.0.0.1/postgres'
    'postgresql://127.0.0.1:54322/postgres'
    'postgresql://postgres:postgres@127.0.0.1:54322/'
    'postgresql://postgres:p%40ss@127.0.0.1:54322/postgres'
    'postgresql://postgres:postgres@127.0.0.1:99999/postgres'
    'service=prod'
    'host=127.0.0.1 port=54322 dbname=postgres'
  )
  for url in "${bad[@]}"; do
    if why="$(parse_local_db_url "$url")"; then
      echo "  FAIL accepted: $url"; fails=$((fails + 1))
    else
      echo "  ok   refused URL: $url"
    fi
  done
  for url in 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
             'postgres://postgres@[::1]:5432/postgres'; do
    if parse_local_db_url "$url" > /dev/null; then echo "  ok   accepted: $url"
    else echo "  FAIL refused a valid URL: $url"; fails=$((fails + 1)); fi
  done

  local var
  for var in PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGOPTIONS PSQLRC; do
    if env "$var=x" bash -c "source '${BASH_SOURCE[0]}'; refuse_redirecting_env" > /dev/null; then
      echo "  FAIL $var was not refused"; fails=$((fails + 1))
    else
      echo "  ok   refused env $var"
    fi
  done

  local cases=(
    '10.0.0.5|yes|postgres'
    'socket|yes|postgres'
    '127.0.0.1||postgres'
    '127.0.0.1|no|postgres'
    '127.0.0.1|yes|postgres fqgpzhwvvfsxswlnbbgg'
    '::1|yes|yqjtawffpesplqyurlpj'
  )
  local c addr marker fp
  for c in "${cases[@]}"; do
    IFS='|' read -r addr marker fp <<< "$c"
    if judge_server "$addr" "$marker" "$fp" > /dev/null; then
      echo "  FAIL server accepted: $c"; fails=$((fails + 1))
    else
      echo "  ok   refused server: $c"
    fi
  done
  if judge_server '127.0.0.1' 'yes' 'postgres' > /dev/null; then echo "  ok   accepted a marked loopback server"
  else echo "  FAIL refused a marked loopback server"; fails=$((fails + 1)); fi

  [ "$fails" -eq 0 ]
}
