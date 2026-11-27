#!/usr/bin/env bash
# Disposable local-only evidence for the row 5b owner receipt: the REAL owner
# read RPC, the REAL Edge shaping module, and the offline verifier on the exact
# receipt the route emits (docs/plans/row5-owner-read.md §5b). Requires the
# trustflow-localdb container; never targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the row 5 read and migration C.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_ownerreceipt_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowownerreceipt.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  docker exec "$container" sh -c "rm -f '$dump' '$dump'.*" || echo "Could not remove $dump in the container" >&2
  rm -rf "$work"
}
trap cleanup EXIT
psql_pg() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
q() { psql_pg <<< "$1"; }
expect() { local label="$1" expected="$2" actual="$3"; [[ "$actual" == "$expected" ]] || { printf 'FAIL %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2; exit 1; }; echo "PASS $label"; }

docker exec "$container" createdb -U supabase_admin -O postgres "$db"
docker exec "$container" pg_dump -U supabase_admin -d postgres --schema-only -Fc -f "$dump"
docker exec "$container" pg_restore -l "$dump" > "$work/toc.full"
grep -c ' SCHEMA \| TABLE ' "$work/toc.full" >/dev/null || { echo 'fixture: TOC has no schemas or tables' >&2; exit 1; }
reviewed='ensure_rls
issue_graphql_placeholder
issue_pg_cron_access
issue_pg_graphql_access
issue_pg_net_access
pgrst_ddl_watch
pgrst_drop_watch'
awk '$4 == "EVENT" && $5 == "TRIGGER" { print $7 }' "$work/toc.full" | sort > "$work/excluded"
if [[ "$(cat "$work/excluded")" != "$reviewed" ]]; then
  echo 'fixture: event triggers differ from the reviewed set' >&2; exit 1
fi
awk '!($4 == "EVENT" && $5 == "TRIGGER")' "$work/toc.full" > "$work/toc.list"
[[ $(( $(wc -l < "$work/toc.full") - $(wc -l < "$work/toc.list") )) -eq 7 ]] || { echo 'fixture: TOC filter removed other than 7 entries' >&2; exit 1; }
docker cp "$work/toc.list" "$container:$dump.list"
echo 'fixture: restoring'
docker exec "$container" pg_restore -U supabase_admin -d "$db" --exit-on-error -L "$dump.list" "$dump"
echo 'fixture: applying migrations through the row 5 read and migration C'
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append \
         20261124231214_delegated_owner_read 20261125214511_drop_v5_check; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
[[ "$(q "select (not exists (select from pg_constraint where conrelid = 'public.events'::regclass and conname = 'events_v5_writes_disabled')) and ((select open from private.v5_write_gate where id) is false)")" == t ]] || { echo 'FAIL post-C catalog or closed gate' >&2; exit 1; }
echo "PASS $db: 20261125214511_drop_v5_check applied; CHECK absent; gate closed"

owner=11111111-1111-4111-8111-111111111111
cD=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1   # draft: owner rows, then a writer-built v5 row
cG=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab2   # a genuine invite acceptance, then a v5 row
cT=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab3   # 501 owner rows: a capped read
cS=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab4   # large notes: the envelope at the event byte cap
cV=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab5   # draft, v5 rows only
cW=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab6   # schema worst case: near-cap events, ~500 acts, fields at CHECK limits
cX=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab7   # the same trail with a DoD past its CHECK limit
guest=guest-actor@example.test
h() { printf "repeat('%s', 64)" "$1"; }
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'receipt-owner@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by, earner_display_name, invited_hirer_email) values
  ('$cD', '$owner', 'receipt cD', '["ship it"]', 3000, 'creator', 'Owner D', null),
  ('$cG', '$owner', 'receipt cG', '["deliver the report"]', 5000, 'creator', 'Owner G', '$guest'),
  ('$cT', '$owner', 'receipt cT', '["many"]', 1, 'creator', null, null),
  ('$cS', '$owner', 'receipt cS', '["large"]', 1, 'creator', null, null),
  ('$cV', '$owner', 'receipt cV', '["v5 only"]', 2000, 'creator', 'Owner V', null);
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, created_at, expires_at, revoked_at) values
  ('cccccccc-0000-4000-8000-0000000000d1', '$cD', '$owner', 'owner_account', $(h 1), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000d2', '$cD', '$owner', 'owner_account', $(h 2), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000a1', '$cG', '$owner', 'owner_account', $(h 3), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000a2', '$cG', '$owner', 'owner_account', $(h 4), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000e1', '$cT', '$owner', 'owner_account', $(h 5), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000f1', '$cS', '$owner', 'owner_account', $(h 6), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000b1', '$cV', '$owner', 'owner_account', $(h 7), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000b2', '$cV', '$owner', 'owner_account', $(h 8), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null);
SQL

fx() { deno run --no-lock --quiet tests/sql/owner_read_receipt_fixture.ts "$@"; }
deno_ts() { deno run --no-lock --quiet tests/sql/delegated_proposal.ts "$@"; }
acc_fx() { deno run --no-lock --quiet tests/sql/owner_read_fixture.ts "$@"; }
contract_json() { q "select to_jsonb(k) from public.contracts k where id = '$1'"; }
# Through a file in the container: a 501-row trail exceeds the argument limit.
insert_rows() { printf '%s' "$1" > "$work/rows.json"; docker cp -q "$work/rows.json" "$container:$dump.rows"
  psql_pg > /dev/null <<SQL
\\set rows \`cat $dump.rows\`
insert into public.events select * from jsonb_populate_recordset(null::public.events, :'rows'::jsonb);
SQL
}
trail() { jq -c --arg o "$owner" --argjson n "$2" '{contract: ., ownerId: $o, notes: [range($n) | "note \(.)"]}' <<< "$(contract_json "$1")" | fx trail; }
# One real v5 append through the row 4 writer, gate opened for it only.
append_v5() { local c="$1" grant="$2" hx="$3" accepted="$4"
  local prop; prop="$(q "select jsonb_build_object('contract', to_jsonb(k), 'tip', (select e.event_hash from public.events e where e.contract_id = '$c' order by e.created_at desc, e.id desc limit 1), 'credentialId', '$grant',
    'type', 'payment.acknowledged', 'payload', '{\"note\":\"paid\"}'::jsonb, 'key', null, 'acceptedVersion', $accepted)
    from public.contracts k where id = '$c'" | deno_ts build)"
  psql_pg -v prop="$prop" <<SQL
update private.v5_write_gate set open = true;
select public.append_delegated_event('$c', '$grant', $(h "$hx"), p->>'performed_by', p->'hashed_inputs', p->'event')->>'status'
  from (select :'prop'::jsonb p) s;
update private.v5_write_gate set open = false;
SQL
}
# The RPC result, optionally under a session time zone, then the route's shaping.
envelope() { psql_pg <<SQL | fx shape
${4:+set timezone = '$4';}
select public.read_delegated_owner_deal('$1', '$2', $(h "$3"));
SQL
}
# The exact emitted receipt through the offline verifier: "<exit>|<last line>".
verify() { jq '.receipt' <<< "$1" > "$work/receipt.json"
  local rc=0; node scripts/verify-receipt.mjs "$work/receipt.json" > "$work/verify.out" 2>&1 || rc=$?
  echo "$rc|$(tail -1 "$work/verify.out")"; }
fails() { grep '^FAIL' "$work/verify.out" | sed 's/  — .*//' | paste -sd ';' -; }

# ── Draft: real owner rows, then a real v5 row; the receipt verifies offline ─
insert_rows "$(trail "$cD" 2)"
expect 'cD: the v5 row appends after two owner rows' appended "$(append_v5 "$cD" cccccccc-0000-4000-8000-0000000000d2 2 null)"
out="$(envelope "$cD" cccccccc-0000-4000-8000-0000000000d1 1)"
j() { jq -r "$1" <<< "$out"; }
expect 'cD: envelope keys' 'contract,events,read_boundary,receipt' "$(j 'keys | join(",")')"
expect 'cD: stored formats, all inputs projected' 'legacy:true,legacy:true,v5:true' "$(j '[.events[] | "\(.stored_format):\(.canonical_inputs_complete)"] | join(",")')"
expect 'cD: receipt read boundary' 'first_event,true,1,500' "$(j '.receipt.read | [.start, .tail_complete, .pages, .row_cap] | map(tostring) | join(",")')"
# Every hash and link recomputes; legacy acts before any acceptance have no
# agreement baseline, which the verifier reports as incomplete, not failed.
expect 'cD: the emitted receipt is incomplete (exit 3), not failed' '3' "$(verify "$out" | cut -d'|' -f1)"
expect 'cD: no FAIL line: every act recomputed and links' '' "$(fails)"
expect 'cD: hash, link and completeness pass; agreement indeterminate' \
  '"hash":"pass","link":"pass","payload":"indeterminate","agreement":"indeterminate","completeness":"pass"' \
  "$(grep -o '"hash":"[a-z_]*","link":"[a-z_]*","payload":"[a-z_]*","agreement":"[a-z_]*","completeness":"[a-z_]*"' "$work/verify.out")"
expect 'cD: timestamp tokens carried as presence only' 'false,false,false|0' "$(j '[.receipt.acts[].timestamp_token_present] | map(tostring) | join(",")')|$(grep -c tsa_token <<< "$out" || true)"
# created_at as the RPC encodes it: to_jsonb(timestamptz), in the session's
# zone. Both canonicalizers normalize it; a non-UTC session changes the text,
# not a single digest.
ny="$(envelope "$cD" cccccccc-0000-4000-8000-0000000000d1 1 America/New_York)"
expect 'created_at: the RPC text differs by session zone' 'true' "$(jq -r --argjson u "$out" '.events[0].created_at != $u.events[0].created_at' <<< "$ny")"
utc_verdict="$(verify "$out")|$(fails)|$(grep -c '^ ok' "$work/verify.out")"
expect 'created_at: the same verifier outcome, check for check, under America/New_York' "$utc_verdict" "$(verify "$ny")|$(fails)|$(grep -c '^ ok' "$work/verify.out")"
expect 'created_at: the v5 canonical text in the receipt keeps the stored instant' \
  "$(q "select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS') from public.events where contract_id = '$cD' and hash_version = 5")" \
  "$(jq -r '.receipt.acts[2].canonical.created_at' <<< "$ny" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(new Date(s.trim()).toISOString().slice(0,23)))')"
expect 'cD: no contact address anywhere in the envelope' 0 "$(grep -c '@' <<< "$out" || true)"

# ── Draft, v5 only: the emitted receipt verifies offline ────────────────────
expect 'cV: first v5 row from genesis' appended "$(append_v5 "$cV" cccccccc-0000-4000-8000-0000000000b2 8 null)"
expect 'cV: second v5 row' appended "$(append_v5 "$cV" cccccccc-0000-4000-8000-0000000000b2 8 null)"
out="$(envelope "$cV" cccccccc-0000-4000-8000-0000000000b1 7)"
expect 'cV: the emitted receipt verifies offline (pre-acceptance)' '0|RECEIPT VERIFIED — pre-acceptance chain only (agreement: no_acceptance).' \
  "$(verify "$out" | cut -d'|' -f1)|$(grep '^RECEIPT' "$work/verify.out")"
expect 'cV: no FAIL line' '' "$(fails)"

# ── Accepted: a genuine invite acceptance (guest actor), then v5 ─────────────
acc="$(q "select jsonb_build_object('contract', to_jsonb(k), 'email', '$guest') from public.contracts k where id = '$cG'" | acc_fx acceptance)"
insert_rows "[$acc]"
q "update public.contracts set state = 'TERMS_ACCEPTED', hirer_email = '$guest' where id = '$cG'" > /dev/null
expect 'cG: the v5 row appends after the acceptance' appended "$(append_v5 "$cG" cccccccc-0000-4000-8000-0000000000a2 4 1)"
out="$(envelope "$cG" cccccccc-0000-4000-8000-0000000000a1 3)"
expect 'cG: the guest actor is withheld and declared on the act, not substituted' 'false|actor_id|false' \
  "$(j '.receipt.acts[0] | (.canonical | has("actor_id") | tostring) + "|" + (.canonical_withheld | join(",")) + "|" + (has("actor_id") | tostring)')"
expect 'cG: the accepted terms come from the acceptance in the prefix' "ok|$(j '.events[0].id')" "$(j '.receipt.agreement | .accepted_status + "|" + .accepted.acceptance_event_id')"
expect 'cG: no contact address anywhere in the envelope' 0 "$(grep -c '@' <<< "$out" || true)"
# Decision (a), Codex T202 / Kenji 2026-11-25: the declared withheld actor
# makes that act's hash unavailable. Incomplete, with no failed check.
expect 'cG: verifier exit 3 (incomplete), not failed' '3' "$(verify "$out" | cut -d'|' -f1)"
expect 'cG: no FAIL line' '' "$(fails)"
expect 'cG: the acceptance hash is unavailable, its links and agreement still checked' 1 \
  "$(grep -c '^ ok  \[0\] legacy hash=unavailable link=linked agreement=match' "$work/verify.out" || true)"
expect 'cG: the v5 act recomputes beside it' 1 "$(grep -c '^ ok  \[1\] v5 hash=match link=linked' "$work/verify.out" || true)"
expect 'cG: the accepted snapshot still proves the recorded digest' 1 \
  "$(grep -c '^ ok  the accepted agreement follows from its snapshot and the acceptance act' "$work/verify.out" || true)"
expect 'cG: the receipt states the unavailable hash among its limits' 'true' \
  "$(j '.receipt.not_verifiable_here | any(startswith("The event hash of any act listing canonical_withheld"))')"
expect 'cG: delegated acts carry no idempotency_key field' 'false' "$(j '.receipt.acts | any(has("idempotency_key"))')"

# ── Capped: 501 rows; the prefix is never labelled complete ─────────────────
insert_rows "$(trail "$cT" 501)"
out="$(envelope "$cT" cccccccc-0000-4000-8000-0000000000e1 5)"
expect 'cT: 500 of 501 returned, truncated' '500,501,true' "$(j '.read_boundary | [.returned_count, .total_count, .truncated] | map(tostring) | join(",")')"
expect 'cT: receipt tail_complete false' 'false' "$(j '.receipt.read.tail_complete')"
expect 'cT: verifier exit 3 (incomplete), no failed check' '3|' "$(verify "$out" | cut -d'|' -f1)|$(fails)"
env_t="$(printf '%s' "$out" | wc -c | tr -d ' ')"

# ── Envelope size at the event byte cap ─────────────────────────────────────
notes="$(jq -cn '[range(3) | ("あ" * 100000)]')"
insert_rows "$(jq -c --arg o "$owner" --argjson n "$notes" '{contract: ., ownerId: $o, notes: $n}' <<< "$(contract_json "$cS")" | fx trail)"
out="$(envelope "$cS" cccccccc-0000-4000-8000-0000000000f1 6)"
env_s="$(printf '%s' "$out" | wc -c | tr -d ' ')"
ev_s="$(j '.read_boundary.returned_bytes')"
echo "MEASURE envelope bytes: 500 small events $env_t; 3 large events $env_s (event array as jsonb text $ev_s, cap 1048576)"
expect 'cS: the large events stay under the event cap, untruncated' 'false' "$(j '.read_boundary.truncated')"
expect 'cS: the envelope adds at most 64 KiB to its event array' 1 "$(( env_s <= ev_s + 65536 ))"
expect 'cT: 500 small events stay under 2 MiB with their receipt' 1 "$(( env_t <= 2097152 ))"

# ── The whole encoded response against the route's 2 MiB ceiling ───────────
# cW is the worst case the schema admits: near-cap projected events, close to
# 500 receipt acts, escaped and multibyte text (", \, newline, あ), and every
# agreement field at its CHECK limit (DoD 20000 characters across 50 items,
# project name 500, display name 200), which the contract, the current and the
# accepted snapshot all repeat outside the SQL event cap. cX is the same trail
# with its DoD past that limit (CHECK dropped in this disposable DB only), to
# show the ceiling refusing a response that does not fit.
size() { psql_pg <<SQL | fx size
select public.read_delegated_owner_deal('$1', '$2', $(h "$3"));
SQL
}
note="$(jq -cn '"あ\"\\\n" * 66')"
dod_max="$(jq -cn '[range(50) | ("あ" * 390) + "\"\\\n"]')"
dod_over="$(jq -cn '[range(400) | "あ\"\\\n" * 110]')"
name_max="$(printf 'あ%.0s' $(seq 498))\"\\"
display_max="$(printf 'あ%.0s' $(seq 198))\"\\"
# Large values reach psql through files in the container, past the argv limit.
put() { printf '%s' "$2" > "$work/$1"; docker cp -q "$work/$1" "$container:$dump.$1"; }
put dmax "$dod_max"; put dover "$dod_over"; put pname "$name_max"; put dname "$display_max"
psql_pg > /dev/null <<SQL
\\set dmax \`cat $dump.dmax\`
\\set dover \`cat $dump.dover\`
\\set pname \`cat $dump.pname\`
\\set dname \`cat $dump.dname\`
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by, earner_display_name, invited_hirer_email) values
  ('$cW', '$owner', :'pname', :'dmax'::jsonb, 7000, 'creator', :'dname', '$guest');
alter table public.contracts drop constraint contracts_dod_shape_check;
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by, earner_display_name, invited_hirer_email) values
  ('$cX', '$owner', :'pname', :'dover'::jsonb, 7000, 'creator', :'dname', '$guest');
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, created_at, expires_at, revoked_at) values
  ('cccccccc-0000-4000-8000-0000000000c1', '$cW', '$owner', 'owner_account', $(h 9), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('cccccccc-0000-4000-8000-0000000000c2', '$cX', '$owner', 'owner_account', $(h 0), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null);
SQL
expect 'cW: DoD, project and display names at their CHECK limits' '20000,500,200' \
  "$(q "select length(dod::text) || ',' || length(project_name) || ',' || length(earner_display_name) from public.contracts where id = '$cW'")"
for c in "$cW" "$cX"; do
  insert_rows "[$(q "select jsonb_build_object('contract', to_jsonb(k), 'email', '$guest') from public.contracts k where id = '$c'" | acc_fx acceptance)]"
  tipc="$(q "select event_hash from public.events where contract_id = '$c'")"
  insert_rows "$(jq -c --arg o "$owner" --arg p "$tipc" --argjson t "$note" '{contract: ., ownerId: $o, prev: $p, notes: [range(499) | $t]}' <<< "$(contract_json "$c")" | fx trail)"
done
measure() { local sz; sz="$(size "$@")"
  local text; text="$(tail -n +2 <<< "$sz")"
  echo "$(head -1 <<< "$sz"),$(printf '%s' "$text" | wc -c | tr -d ' '),$(jq -r '[.read_boundary.returned_count, .read_boundary.returned_bytes, (.receipt.acts | length)] | map(tostring) | join(",")' <<< "$text")"; }
IFS=, read -r w_bytes w_over w_text w_n w_ev w_acts <<< "$(measure "$cW" cccccccc-0000-4000-8000-0000000000c1 9)"
IFS=, read -r x_bytes x_over x_text x_n x_ev x_acts <<< "$(measure "$cX" cccccccc-0000-4000-8000-0000000000c2 0)"
echo "MEASURE cW schema worst case: $w_bytes bytes, $w_n events ($w_ev event-array bytes), $w_acts acts; cX past the DoD limit: $x_bytes bytes; ceiling 2097152"
expect 'size: the measured bytes are the UTF-8 length of the text the route sends' "$w_bytes|$x_bytes" "$w_text|$x_text"
expect 'size: cW has near-cap events and near-500 acts' 1 "$(( w_n >= 450 && w_ev >= 1000000 && w_acts == w_n ))"
expect 'size: the schema-admitted worst case fits under the ceiling' 'false' "$w_over"
expect 'size: past the schema limit the route would answer response_too_large' 'true' "$x_over"

echo 'ALL PASS'
