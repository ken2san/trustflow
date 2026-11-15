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
#
# WHAT IT CANNOT PROVE: loopback is not a disposable backend. A local port
# forward or tunnel to a hosted server listening on its own loopback reports a
# loopback address too, and the marker and project-ref checks are not an
# identity proof. Before write mode the operator must confirm the local
# listener is a throwaway database, not a forward to anything else.

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
# last part runs SCRIPT itself with PATH holding only a stub `psql` that
# records what it was handed and fails, so it shows what would reach libpq and
# that a refusal comes before any connection attempt. Every step checks its
# own result: callers may run this on the left of && or ||, where bash turns
# errexit off, so nothing here may rely on set -e (Codex Task 78).
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

  # Stub setup must fail closed: a broken stub stops the run, never lets the
  # script look further for a psql.
  local work bin out
  for bin in '' 'relative/bin'; do
    if guard_stub_bin "$bin" > /dev/null; then
      echo "  FAIL setup accepted stub dir '$bin'"; fails=$((fails + 1))
    else
      echo "  ok   setup refused stub dir '$bin'"
    fi
  done
  if out="$(TMPDIR=/nonexistent/guard-self-check guard_script_check "$script")"; then
    echo "  FAIL script check passed with no temp dir"; fails=$((fails + 1))
  elif [[ "$out" == *"FAIL setup"* && "$out" != *"script:"* ]]; then
    echo "  ok   no temp dir: refused before any script run"
  else
    echo "  FAIL no temp dir: $out"; fails=$((fails + 1))
  fi
  if ! work="$(mktemp -d)" || [ ! -d "$work" ]; then
    echo "  FAIL setup: mktemp -d for the setup-failure checks"; return 1
  fi
  if ! mkdir "$work/ro" || ! chmod 500 "$work/ro"; then
    echo "  FAIL setup: read-only dir for the setup-failure checks"; rm -rf "$work"; return 1
  fi
  if guard_stub_bin "$work/ro" > /dev/null; then
    echo "  FAIL setup accepted an unwritable stub dir"; fails=$((fails + 1))
  else
    echo "  ok   setup refused an unwritable stub dir"
  fi
  chmod 700 "$work/ro"
  # Each mutation is made to $work/bin — the directory guard_run_script
  # verifies and puts on PATH — after a positive control has shown the runner
  # does start the script with that same stub intact (Codex Task 79: the
  # mutated dir was not the one the runner checked, so these passed vacuously).
  local broken url_ok='postgresql://raceuser@127.0.0.1:54329/race_db'
  for broken in 'chmod 600 "$bin/psql"' 'rm "$bin/psql"' \
                'printf "exec /usr/bin/false\n" > "$bin/psql"' \
                'rm "$bin/psql"; ln -s /usr/bin/false "$bin/psql"' \
                'printf "" > "$bin/postgres"'; do
    bin="$work/bin"
    rm -rf "$bin" "$work/psql.log"
    if ! mkdir "$bin" || ! guard_stub_bin "$bin" > /dev/null; then
      echo "  FAIL setup: good stub for case: $broken"; fails=$((fails + 1)); continue
    fi
    guard_run_script "$work" "$script" LOCAL_DB_URL="$url_ok" > /dev/null
    if [ "$GUARD_RUN" = ran-failed ] && [ -s "$work/psql.log" ]; then
      echo "  ok   control: intact stub, the runner started the script and psql was called"
    else
      echo "  FAIL control: intact stub gave $GUARD_RUN, case skipped: $broken"; fails=$((fails + 1)); continue
    fi
    eval "$broken"
    if guard_stub_verify "$bin" > /dev/null; then
      echo "  FAIL stub verify passed after: $broken"; fails=$((fails + 1))
    else
      echo "  ok   stub verify refused after: $broken"
    fi
    rm -f "$work/psql.log"
    guard_run_script "$work" "$script" LOCAL_DB_URL="$url_ok" > /dev/null
    if [ "$GUARD_RUN" = not-run ] && [ ! -e "$work/psql.log" ]; then
      echo "  ok   script not run after: $broken"
    else
      echo "  FAIL script ran ($GUARD_RUN) after: $broken"; fails=$((fails + 1))
    fi
  done
  rm -rf "$work"

  if ! guard_script_check "$script"; then fails=$((fails + 1)); fi
  if [ "$fails" -ne 0 ]; then
    echo "guard self-check: $fails failure(s)"
    return 1
  fi
  return 0
}

# The stub: logs its conninfo and PGPASSWORD, then fails like a refused
# connection. It never connects anywhere.
GUARD_STUB='#!/bin/sh
printf "%s\n" "$1" "PGPASSWORD=${PGPASSWORD-}" >> "$GUARD_STUB_LOG"
exit 1'
# What the script runs before its first psql call; linked next to the stub.
GUARD_STUB_TOOLS='dirname env grep tr'

# guard_stub_bin DIR — fills DIR (absolute, existing, writable) with the stub
# psql and links to GUARD_STUB_TOOLS, then verifies it. Returns 1 at the first
# step that fails.
guard_stub_bin() {
  local bin="$1" t p
  case "$bin" in
    /*) ;;
    *) echo "  FAIL setup: stub dir '$bin' is not an absolute path"; return 1 ;;
  esac
  if [ ! -d "$bin" ] || [ ! -w "$bin" ]; then
    echo "  FAIL setup: stub dir '$bin' is missing or not writable"; return 1
  fi
  if ! printf '%s\n' "$GUARD_STUB" > "$bin/psql" 2> /dev/null; then
    echo "  FAIL setup: could not write $bin/psql"; return 1
  fi
  if ! chmod 700 "$bin/psql"; then
    echo "  FAIL setup: could not chmod $bin/psql"; return 1
  fi
  for t in $GUARD_STUB_TOOLS; do
    if ! p="$(command -v "$t")"; then echo "  FAIL setup: $t not found"; return 1; fi
    case "$p" in
      /*) ;;
      *) echo "  FAIL setup: $t is '$p', not an executable path"; return 1 ;;
    esac
    if ! ln -s "$p" "$bin/$t"; then echo "  FAIL setup: could not link $t"; return 1; fi
  done
  guard_stub_verify "$bin"
}

# guard_stub_verify DIR — with PATH=DIR, psql resolves to DIR/psql, which is
# an executable regular file holding exactly GUARD_STUB, and DIR holds nothing
# but the stub and the tool links. PATH is DIR alone, so no other directory
# can supply a real psql if the stub is ever missing.
guard_stub_verify() {
  local bin="$1" found names want
  if [ ! -f "$bin/psql" ] || [ -L "$bin/psql" ] || [ ! -x "$bin/psql" ]; then
    echo "  FAIL setup: $bin/psql is not an executable regular file"; return 1
  fi
  if [ "$(cat "$bin/psql")" != "$GUARD_STUB" ]; then
    echo "  FAIL setup: $bin/psql is not the stub"; return 1
  fi
  found="$(env -i PATH="$bin" "$BASH" -c 'command -v psql' || true)"
  if [ "$found" != "$bin/psql" ]; then
    echo "  FAIL setup: psql resolves to '$found', not $bin/psql"; return 1
  fi
  names="$(ls -A "$bin" | sort | tr '\n' ' ')"
  want="$(printf '%s\n' psql $GUARD_STUB_TOOLS | sort | tr '\n' ' ')"
  if [ "$names" != "$want" ]; then
    echo "  FAIL setup: $bin holds '$names', want '$want'"; return 1
  fi
  return 0
}

# guard_run_script WORK SCRIPT VAR=VALUE… — runs SCRIPT under env -i with
# PATH=WORK/bin only, the stub's log in WORK/psql.log and its output in
# WORK/out. Sets GUARD_RUN to not-run (stub failed verification, nothing
# started), ran-ok or ran-failed.
guard_run_script() {
  local work="$1" script="$2"; shift 2
  GUARD_RUN=not-run
  guard_stub_verify "$work/bin" || return 0
  if ! : > "$work/psql.log"; then echo "  FAIL setup: could not reset the stub log"; return 0; fi
  if env -i PATH="$work/bin" GUARD_STUB_LOG="$work/psql.log" "$@" \
       "$BASH" "$script" > "$work/out" 2>&1; then
    GUARD_RUN=ran-ok
  else
    GUARD_RUN=ran-failed
  fi
  return 0
}

# guard_script_check SCRIPT — SCRIPT run end to end against the stub. Returns
# 0 only if setup succeeded and every case passed; a setup failure runs no case.
guard_script_check() {
  local script="$1" fails=0 work c url want pass var
  # An explicit template: macOS mktemp -d quietly falls back to /tmp when
  # TMPDIR is missing, which would hide the failure the self-check injects.
  if ! work="$(mktemp -d "${TMPDIR:-/tmp}/race-guard.XXXXXX" 2> /dev/null)" \
     || [ -z "$work" ] || [ ! -d "$work" ]; then
    echo "  FAIL setup: mktemp -d failed"; return 1
  fi
  if ! mkdir "$work/bin" || ! guard_stub_bin "$work/bin"; then
    rm -rf "$work"; return 1
  fi

  # A valid URL: exactly the parsed parts reach psql, quoted; the stub's
  # failure then stops the run at the server check, before any write.
  for c in \
    "postgresql://raceuser:race.pass@127.0.0.1:54329/race_db|host='127.0.0.1' port='54329' dbname='race_db' user='raceuser' application_name='race-guest'|PGPASSWORD=race.pass" \
    "postgres://raceuser@[::1]:5432/race_db|host='::1' port='5432' dbname='race_db' user='raceuser' application_name='race-guest'|PGPASSWORD="; do
    IFS='|' read -r url want pass <<< "$c"
    guard_run_script "$work" "$script" LOCAL_DB_URL="$url"
    if [ "$GUARD_RUN" != ran-failed ]; then
      echo "  FAIL script: $GUARD_RUN against the stub: $url"; fails=$((fails + 1))
    elif [ "$(cat "$work/psql.log")" = "$want"$'\n'"$pass" ] && grep -q 'refusing this server' "$work/out"; then
      echo "  ok   script: psql got only the parsed parts, then refused the server: $url"
    else
      echo "  FAIL script: psql got '$(tr '\n' '|' < "$work/psql.log")' for $url"; fails=$((fails + 1))
    fi
  done

  # Refusals: the stub must never have been called, and the script must have
  # stopped for the expected guard reason, not some unrelated early failure.
  local ok_url='postgresql://raceuser:race.pass@127.0.0.1:54329/race_db'
  local env_why='FAIL: unset these first, they can change where libpq connects:'
  local url_why='FAIL: LOCAL_DB_URL: not postgres[ql]://user[:password]@127.0.0.1|[::1]:port/dbname'
  refused() { # refused <label> <expected stderr line> VAR=VALUE…
    local label="$1" why="$2"; shift 2
    guard_run_script "$work" "$script" "$@"
    if [ "$GUARD_RUN" != ran-failed ]; then
      echo "  FAIL script: $GUARD_RUN for $label"; fails=$((fails + 1))
    elif [ -s "$work/psql.log" ]; then
      echo "  FAIL script: psql was called before refusing $label"; fails=$((fails + 1))
    elif ! grep -qxF -- "$why" "$work/out"; then
      echo "  FAIL script: $label refused for another reason: $(tr '\n' '|' < "$work/out")"
      fails=$((fails + 1))
    else
      echo "  ok   script: refused $label before psql: $why"
    fi
  }
  refused "no LOCAL_DB_URL" "$url_why with no query, list or encoding"
  for var in DB_USER DB_PASS DB_HOST DB_PORT DB_NAME; do
    refused "inherited $var" "$env_why $var " \
      LOCAL_DB_URL="$ok_url" "$var=db.yqjtawffpesplqyurlpj.supabase.co"
  done
  refused "inherited empty DB_PASS" "$env_why DB_PASS " LOCAL_DB_URL="$ok_url" DB_PASS=
  refused "inherited PGHOST" "$env_why PGHOST " \
    LOCAL_DB_URL="$ok_url" PGHOST=db.yqjtawffpesplqyurlpj.supabase.co
  for url in "${inject[@]}"; do # guard_self_check's list
    refused "$url" "$url_why with no query, list or encoding" LOCAL_DB_URL="$url"
  done

  rm -rf "$work"
  [ "$fails" -eq 0 ]
}
