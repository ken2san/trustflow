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
#      parsed parts, so what connects is exactly what was validated. Each part
#      is checked against its charset again when the conninfo is built, then
#      single-quoted, so no value can add a conninfo keyword.
#   3. Any PG* or PSQL* environment variable is refused outright, and psql is
#      run with -X (no psqlrc). So are inherited DB_USER/DB_PASS/DB_HOST/
#      DB_PORT/DB_NAME: the parsed parts live in those names, and a value that
#      came from the caller instead of the parser must never reach libpq
#      (Codex Task 77: parsing inside $(...) lost the parsed values, and
#      exported ones were used in their place).
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
# exercised by `guard_self_check` without touching any database; it also runs
# the real script against a stub psql to show what reaches libpq.

GUARD_REFS='fqgpzhwvvfsxswlnbbgg yqjtawffpesplqyurlpj'

GUARD_DB_VARS='DB_USER DB_PASS DB_HOST DB_PORT DB_NAME'

# parse_local_db_url URL — on success sets DB_USER DB_PASS DB_HOST DB_PORT
# DB_NAME and returns 0; otherwise leaves them unset, puts the reason in
# GUARD_WHY and returns 1. Call it in the current shell, never inside $(...):
# a subshell's assignments do not come back.
parse_local_db_url() {
  local url="$1"
  local re='^postgres(ql)?://([A-Za-z0-9._-]+)(:([A-Za-z0-9._~-]*))?@(127\.0\.0\.1|\[::1\]):([0-9]{1,5})/([A-Za-z0-9_-]+)$'
  unset $GUARD_DB_VARS
  GUARD_WHY=""
  if [[ ! "$url" =~ $re ]]; then
    GUARD_WHY="not postgres[ql]://user[:password]@127.0.0.1|[::1]:port/dbname with no query, list or encoding"
    return 1
  fi
  if [ "$((10#${BASH_REMATCH[6]}))" -lt 1 ] || [ "$((10#${BASH_REMATCH[6]}))" -gt 65535 ]; then
    GUARD_WHY="port out of range"
    return 1
  fi
  DB_USER="${BASH_REMATCH[2]}"
  DB_PASS="${BASH_REMATCH[4]}"
  DB_HOST="${BASH_REMATCH[5]}"
  DB_PORT="${BASH_REMATCH[6]}"
  DB_NAME="${BASH_REMATCH[7]}"
  [ "$DB_HOST" = "[::1]" ] && DB_HOST="::1"
  return 0
}

# conninfo_value VALUE — VALUE as a single-quoted libpq conninfo value.
conninfo_value() {
  local bs='\' q="'" v="$1"
  v="${v//"$bs"/$bs$bs}"
  v="${v//"$q"/$bs$q}"
  printf "'%s'" "$v"
}

# local_conninfo APP — the keyword conninfo for the parsed parts, without the
# password (that goes in PGPASSWORD for the psql process only). Every part is
# re-checked here, so a value that did not come from parse_local_db_url — or
# a parse that never happened — is refused rather than connected with. The
# patterns sit in variables: bash 3.2 mis-reads an inline regex containing '|'
# when the caller has set IFS='|'.
local_conninfo() {
  local app="$1"
  local name_re='^[A-Za-z0-9._-]+$' pass_re='^[A-Za-z0-9._~-]*$'
  local host_re='^(127\.0\.0\.1|::1)$' port_re='^[0-9]{1,5}$' db_re='^[A-Za-z0-9_-]+$'
  [[ "${DB_USER:-}" =~ $name_re ]] || { echo "user unset or unsafe"; return 1; }
  [[ "${DB_PASS-}" =~ $pass_re ]] || { echo "password unsafe"; return 1; }
  [[ "${DB_HOST:-}" =~ $host_re ]] || { echo "host unset or not loopback"; return 1; }
  [[ "${DB_PORT:-}" =~ $port_re ]] || { echo "port unset or unsafe"; return 1; }
  [[ "${DB_NAME:-}" =~ $db_re ]] || { echo "dbname unset or unsafe"; return 1; }
  [[ "$app" =~ $name_re ]] || { echo "application name unsafe"; return 1; }
  echo "host=$(conninfo_value "$DB_HOST") port=$(conninfo_value "$DB_PORT")" \
       "dbname=$(conninfo_value "$DB_NAME") user=$(conninfo_value "$DB_USER")" \
       "application_name=$(conninfo_value "$app")"
}

# refuse_redirecting_env — every PG*/PSQL* variable, set to anything. Listing
# the dangerous ones (PGHOST, PGHOSTADDR, PGSERVICE, PGSERVICEFILE,
# PGSYSCONFDIR, PGOPTIONS, PGTARGETSESSIONATTRS, …) would be a list to keep
# current; refusing the prefix is not.
# The parser's own output names are refused too when inherited: see 3. above.
refuse_redirecting_env() {
  local found var
  found="$(env | grep -oE '^(PG|PSQL)[A-Za-z0-9_]*=' | tr -d '=' | tr '\n' ' ' || true)"
  for var in $GUARD_DB_VARS; do
    if [ -n "${!var+set}" ]; then found="$found$var "; fi
  done
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

# guard_self_check SCRIPT — every rejection path, no connection made. The
# last part runs SCRIPT itself with a stub `psql` first on PATH that records
# what it was handed and fails, so it shows what would reach libpq and that a
# refusal comes before any connection attempt.
guard_self_check() {
  local script="$1" fails=0 url
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
    'postgresql://postgres:postgres@127.0.0.1:0/postgres'
    'service=prod'
    'host=127.0.0.1 port=54322 dbname=postgres'
  )
  # Each of these would add a conninfo keyword if a part were pasted in raw.
  local inject=(
    "postgresql://postgres:x' host='db.yqjtawffpesplqyurlpj.supabase.co@127.0.0.1:54322/postgres"
    'postgresql://postgres:x host=db.yqjtawffpesplqyurlpj.supabase.co@127.0.0.1:54322/postgres'
    'postgresql://postgres@127.0.0.1:54322/postgres host=db.yqjtawffpesplqyurlpj.supabase.co'
    "postgresql://postgres@127.0.0.1:54322/postgres' hostaddr='10.0.0.5"
    'postgresql://post\gres@127.0.0.1:54322/postgres'
    'postgresql://postgres:x=y@127.0.0.1:54322/postgres'
  )
  for url in "${bad[@]}" "${inject[@]}"; do
    if (parse_local_db_url "$url"); then
      echo "  FAIL accepted: $url"; fails=$((fails + 1))
    else
      echo "  ok   refused URL: $url"
    fi
  done

  # Called in this shell, the parts must arrive; after a refusal none may stay.
  local got
  parse_local_db_url 'postgresql://raceuser:race.pass@127.0.0.1:54329/race_db' || true
  got="${DB_USER-}|${DB_PASS-}|${DB_HOST-}|${DB_PORT-}|${DB_NAME-}"
  if [ "$got" = 'raceuser|race.pass|127.0.0.1|54329|race_db' ]; then echo "  ok   parsed parts reach the caller"
  else echo "  FAIL parsed parts: '$got'"; fails=$((fails + 1)); fi
  parse_local_db_url 'postgres://raceuser@[::1]:5432/race_db' || true
  got="${DB_USER-}|${DB_PASS-}|${DB_HOST-}|${DB_PORT-}|${DB_NAME-}"
  if [ "$got" = 'raceuser||::1|5432|race_db' ]; then echo "  ok   parsed [::1] parts reach the caller"
  else echo "  FAIL parsed [::1] parts: '$got'"; fails=$((fails + 1)); fi
  parse_local_db_url 'service=prod' || true
  if [ -z "${DB_USER+x}${DB_PASS+x}${DB_HOST+x}${DB_PORT+x}${DB_NAME+x}" ]; then echo "  ok   a refused URL leaves no parts"
  else echo "  FAIL a refused URL left parts set"; fails=$((fails + 1)); fi

  # local_conninfo refuses parts that did not come from the parser.
  local set
  for set in 'DB_NAME=postgres host=evil' "DB_PASS=a'b" 'DB_HOST=localhost' 'DB_USER=' 'DB_PORT=1 x'; do
    if ( parse_local_db_url 'postgresql://u:p@127.0.0.1:5432/d'; export "${set%%=*}=${set#*=}"
         local_conninfo race-guest > /dev/null ); then
      echo "  FAIL conninfo built with $set"; fails=$((fails + 1))
    else
      echo "  ok   conninfo refused $set"
    fi
  done
  if ( unset $GUARD_DB_VARS; local_conninfo race-guest > /dev/null ); then
    echo "  FAIL conninfo built with no parse"; fails=$((fails + 1))
  else
    echo "  ok   conninfo refused with no parse"
  fi
  got="$(conninfo_value "a'b\\c")"
  if [ "$got" = "'a\\'b\\\\c'" ]; then echo "  ok   conninfo_value escapes quote and backslash"
  else echo "  FAIL conninfo_value: $got"; fails=$((fails + 1)); fi
  unset $GUARD_DB_VARS

  local var
  for var in PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGSYSCONFDIR PGOPTIONS PSQLRC $GUARD_DB_VARS; do
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

  guard_script_check "$script" || fails=$((fails + $?))
  [ "$fails" -eq 0 ]
}

# guard_script_check SCRIPT — SCRIPT run end to end in a clean environment
# (env -i), with a stub psql that logs its conninfo and PGPASSWORD and exits 1.
# Nothing can connect: the only psql on the path is the stub. Returns the
# number of failures.
guard_script_check() {
  local script="$1" fails=0 stub log c url want pass var
  stub="$(mktemp -d)"
  log="$stub/psql.log"
  printf '%s\n' '#!/bin/sh' \
    'printf "%s\n" "$1" "PGPASSWORD=${PGPASSWORD-}" >> "$GUARD_STUB_LOG"' \
    'exit 1' > "$stub/psql"
  chmod +x "$stub/psql"

  # run_script VAR=VALUE… — leaves the stub's log in $log; true if SCRIPT exited 0.
  run_script() {
    : > "$log"
    env -i PATH="$stub:/usr/bin:/bin" GUARD_STUB_LOG="$log" "$@" \
      "$BASH" "$script" > "$stub/out" 2>&1
  }

  # A valid URL: exactly the parsed parts reach psql, quoted; the stub's
  # failure then stops the run at the server check, before any write.
  for c in \
    "postgresql://raceuser:race.pass@127.0.0.1:54329/race_db|host='127.0.0.1' port='54329' dbname='race_db' user='raceuser' application_name='race-guest'|PGPASSWORD=race.pass" \
    "postgres://raceuser@[::1]:5432/race_db|host='::1' port='5432' dbname='race_db' user='raceuser' application_name='race-guest'|PGPASSWORD="; do
    IFS='|' read -r url want pass <<< "$c"
    if run_script LOCAL_DB_URL="$url"; then
      echo "  FAIL script: ran to the end against the stub: $url"; fails=$((fails + 1))
    elif [ "$(cat "$log")" = "$want"$'\n'"$pass" ] && grep -q 'refusing this server' "$stub/out"; then
      echo "  ok   script: psql got only the parsed parts, then refused the server: $url"
    else
      echo "  FAIL script: psql got '$(tr '\n' '|' < "$log")' for $url"; fails=$((fails + 1))
    fi
  done

  # Refusals: the stub must never have been called.
  local ok_url='postgresql://raceuser:race.pass@127.0.0.1:54329/race_db'
  refused() { # refused <label> VAR=VALUE…
    local label="$1"; shift
    if run_script "$@"; then
      echo "  FAIL script: accepted $label"; fails=$((fails + 1))
    elif [ -s "$log" ]; then
      echo "  FAIL script: psql was called before refusing $label"; fails=$((fails + 1))
    else
      echo "  ok   script: refused $label before psql"
    fi
  }
  refused "no LOCAL_DB_URL"
  for var in DB_USER DB_PASS DB_HOST DB_PORT DB_NAME; do
    refused "inherited $var" LOCAL_DB_URL="$ok_url" "$var=db.yqjtawffpesplqyurlpj.supabase.co"
  done
  refused "inherited empty DB_PASS" LOCAL_DB_URL="$ok_url" DB_PASS=
  refused "inherited PGHOST" LOCAL_DB_URL="$ok_url" PGHOST=db.yqjtawffpesplqyurlpj.supabase.co
  for url in "${inject[@]}"; do # guard_self_check's list
    refused "$url" LOCAL_DB_URL="$url"
  done

  rm -rf "$stub"
  return "$fails"
}
