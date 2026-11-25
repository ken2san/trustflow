#!/usr/bin/env bash
# Disposable local-only evidence for 20261124231214_delegated_owner_read (row 5a,
# docs/plans/row5-owner-read.md §5a). Requires the trustflow-localdb container;
# never targets a URL, never a hosted project.
#
# Fixture: the same fail-closed schema-only restore as
# tests/sql/events_v5_authority.sh (owners and ACLs kept, only the 7 reviewed
# platform event triggers left out), then the migrations up to the row 5 read.
set -euo pipefail
cd "$(dirname "$0")/../.."
container="${TF_FIXTURE_CONTAINER:-trustflow-localdb}"
db="trustflow_ownerread_$$"
dump="/tmp/${db}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/trustflowownerread.XXXXXX")"
cleanup() {
  docker exec "$container" dropdb -U supabase_admin --if-exists --force "$db" >/dev/null 2>&1 || echo "Could not drop disposable database $db" >&2
  docker exec "$container" rm -f "$dump" "$dump.list" || echo "Could not remove $dump in the container" >&2
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
echo 'fixture: applying migrations to head, row 4 and the row 5 read'
for m in 20261118214020_entry_agent_credentials 20261120090000_create_entry_contract \
         20261120180000_close_contract_client_insert 20261122130000_events_v5_authority_columns \
         20261124120000_entry_agent_resolver 20261124130000_delegated_owner_append \
         20261124231214_delegated_owner_read; do
  psql_pg -1 -f - < "supabase/migrations/$m.sql" > /dev/null
done
echo 'PASS the row 5 migration applies with its self-test (TF941-TF942)'

owner=11111111-1111-4111-8111-111111111111
other=22222222-2222-4222-8222-222222222222
cA=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1   # the read deal, with a mixed trail
cB=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2   # another deal of the same owner
cE=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3   # empty trail
cO=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4   # owner changes after issuance
cV=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5   # carries a writer-built v5 row
cL=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6   # large trail, for the caps
cG=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7   # a genuine invite acceptance, then a v5 event
cN=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8   # value-domain canaries under approved keys
gR=cccccccc-0000-4000-8000-000000000001   # read on cA
gW=cccccccc-0000-4000-8000-000000000002   # cA, write scope only
gB=cccccccc-0000-4000-8000-000000000003   # read on cB
gX=cccccccc-0000-4000-8000-000000000004   # read on cA, revoked
gT=cccccccc-0000-4000-8000-000000000005   # read on cA, expired
gK=cccccccc-0000-4000-8000-000000000006   # read on cA, counterpart_account issuer
gO=cccccccc-0000-4000-8000-000000000007   # read on cO
gE=cccccccc-0000-4000-8000-000000000008   # read on cE
gV=cccccccc-0000-4000-8000-000000000009   # read on cV
gA=cccccccc-0000-4000-8000-00000000000a   # write on cV, for the real writer
gL=cccccccc-0000-4000-8000-00000000000b   # read on cL
gP=cccccccc-0000-4000-8000-00000000000c   # read + payment.acknowledged on cA, parity
gG=cccccccc-0000-4000-8000-00000000000d   # read on cG
gH=cccccccc-0000-4000-8000-00000000000e   # write on cG, for the real writer
gN=cccccccc-0000-4000-8000-00000000000f   # read on cN
guest=guest-actor@example.test            # a real guest actor: actor_id guest:<address>
h() { printf "repeat('%s', 64)" "$1"; }
psql_pg > /dev/null <<SQL
insert into auth.users (id, email, is_anonymous, email_confirmed_at) values
  ('$owner', 'read-owner@example.test', false, clock_timestamp()),
  ('$other', 'read-other@example.test', false, clock_timestamp());
insert into public.contracts (id, earner_user_id, project_name, dod, amount_jpy, performed_by, earner_display_name,
    invited_hirer_email, hirer_email, invite_token, guest_access_token, stripe_payment_intent_id) values
  ('$cA', '$owner', 'read cA', '["test"]', 1200, 'creator', 'Owner A', 'invited@example.test', 'claimed@example.test',
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'pi_secret_fixture'),
  ('$cB', '$owner', 'read cB', '["test"]', 1, 'creator', null, null, null, null, null, null),
  ('$cE', '$owner', 'read cE', '["test"]', 1, 'creator', null, null, null, null, null, null),
  ('$cO', '$owner', 'read cO', '["test"]', 1, 'creator', null, null, null, null, null, null),
  ('$cV', '$owner', 'read cV', '["test"]', 1, 'creator', null, null, null, null, null, null),
  ('$cL', '$owner', 'read cL', '["test"]', 1, 'creator', null, null, null, null, null, null),
  ('$cG', '$owner', 'read cG', '["deliver the report"]', 5000, 'creator', 'Owner G', '$guest', null, null, null, null),
  ('$cN', '$owner', 'read cN', '["test"]', 1, 'creator', null, null, null, null, null, null);
insert into public.entry_agent_credentials (id, contract_id, issuer_id, issuer_kind, secret_hash, scopes, created_at, expires_at, revoked_at) values
  ('$gR', '$cA', '$owner', 'owner_account', $(h 1), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gW', '$cA', '$owner', 'owner_account', $(h 2), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gB', '$cB', '$owner', 'owner_account', $(h 3), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gX', '$cA', '$owner', 'owner_account', $(h 4), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', clock_timestamp()),
  ('$gT', '$cA', '$owner', 'owner_account', $(h 5), array['read'], clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', null),
  ('$gK', '$cA', '$other', 'counterpart_account', $(h 6), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gO', '$cO', '$owner', 'owner_account', $(h 7), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gE', '$cE', '$owner', 'owner_account', $(h 8), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gV', '$cV', '$owner', 'owner_account', $(h 9), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gA', '$cV', '$owner', 'owner_account', $(h a), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gL', '$cL', '$owner', 'owner_account', $(h b), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gP', '$cA', '$owner', 'owner_account', $(h c), array['read', 'payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gG', '$cG', '$owner', 'owner_account', $(h d), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gH', '$cG', '$owner', 'owner_account', $(h e), array['payment.acknowledged'], clock_timestamp(), clock_timestamp() + interval '1 day', null),
  ('$gN', '$cN', '$owner', 'owner_account', $(h f), array['read'], clock_timestamp(), clock_timestamp() + interval '1 day', null);
update public.contracts set earner_user_id = '$other' where id = '$cO';
-- A legacy trail on cA: statement keys, recorded metadata, a real guest actor,
-- and values that must be withheld: contact addresses (top level, in the guest
-- actor, and nested inside _authentication, _agreement and a metadata field),
-- a user agent, unlisted keys, an idempotency key, a timestamp token, an
-- unknown type.
create function pg_temp.ev(c uuid, typ text, payload jsonb, k text, tsa text, actor text default '$owner') returns void language sql as \$\$
  insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, prev_event_hash,
      hash_version, payload_hash, agreement_hash, dod_hash, idempotency_key, tsa_token)
  values (gen_random_uuid(), typ, c::text, actor, payload, clock_timestamp(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
      null, 4, repeat('1', 64), null, repeat('3', 64), k, tsa) \$\$;
select pg_temp.ev('$cA', 'contract.initiated', '{"step":1,"title":"T","private_note":"withheld","_actor_role":"earner","_auth_method":"account_session","_authentication":{"assurance":"account_session","detail":{"email":"nested-auth@example.test"}},"_extra":"withheld"}', 'idem-secret-1', 'tsa-token-bytes');
select pg_temp.ev('$cA', 'dod.consent_recorded', '{"counterparty_name":"Guest","counterparty_email":"$guest","dod_items":["test"],"user_agent":"UA/1","_actor_role":"guest_hirer","_invited_recipient":"invited@example.test","_claimed_identity":"$guest","_claimed_identity_verified":false,"_agreement":{"snapshot_version":1,"project_name":"read cA","dod":["test"],"amount":1200,"currency":null,"deadline":null,"performed_by":"creator","offered_by":"Owner A","contact":"nested-agreement@example.test"}}', null, null, 'guest:$guest');
select pg_temp.ev('$cA', 'contract.accepted', '{"step":2,"user_agent":"UA/1","_agreement":{"snapshot_version":1,"project_name":"read cA"},"_role_in_agreement":"receiver"}', null, null);
select pg_temp.ev('$cA', 'payment.reported', '{"note":"sent","_claimed_identity_verified":false,"_authentication":{"assurance":"account_session","aal":"aal1","recent_authentication":true}}', null, null);
select pg_temp.ev('$cA', 'x.custom', '{"note":"unknown type","_actor_role":"earner"}', null, null);
select pg_temp.ev('$cA', 'dispute.opened', '{"reason":"withheld _agreement","_agreement":{"snapshot_version":1},"_actor_role":{"email":"meta@example.test"}}', null, null);
-- cN: wrong-shaped values under APPROVED keys (statement and metadata), one
-- valid of each shape, an allowed free-text note that mentions an address, and
-- a UUID-actor row of an unsupported format (projection completeness only).
select pg_temp.ev('$cN', 'dispute.opened', '{"reason":{"to":"nested-reason@example.test"},"_actor_role":"admin-at@example.test"}', null, null);
select pg_temp.ev('$cN', 'dod.consent_recorded', '{"counterparty_name":"N","dod_items":["ok",{"c":"nested-dod@example.test"}],"_auth_method":"meta-auth@example.test","_role_in_agreement":"owner"}', null, null);
select pg_temp.ev('$cN', 'contract.initiated', '{"step":{"n":"nested-step@example.test"},"title":["nested-title@example.test"],"budgetPoints":"12a"}', null, null);
select pg_temp.ev('$cN', 'contract.initiated', '{"step":1,"title":"T","budgetPoints":"5000"}', null, null);
select pg_temp.ev('$cN', 'rating.submitted', '{"rating":4.5}', null, null);
select pg_temp.ev('$cN', 'rating.submitted', '{"rating":4}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":"mail me at text-note@example.test","_authentication":{"assurance":"bearer_capability","credential":"cred@example.test"}}', null, null);
select pg_temp.ev('$cN', 'payment.disputed', '{"note":"n","_authentication":{"assurance":"bearer_capability","act_binding_mechanism":"mech@example.test"}}', null, null);
select pg_temp.ev('$cN', 'payment.acknowledged', '{"note":"n","_authentication":{"assurance":"bearer_capability","act_bound_authentication":true}}', null, null);
select pg_temp.ev('$cN', 'payment.acknowledged', '{"note":"n","_authentication":{"assurance":"bearer_capability","credential":"entry_agent_grant","method":null,"aal":null,"seconds_since_authentication":null,"recent_authentication":false,"recent_authentication_window_seconds":300,"act_bound_authentication":false,"act_binding_mechanism":null}}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":{"cc":"nested-note@example.test"},"_authentication":{"assurance":"account_session","method":"otp","aal":"aal1","seconds_since_authentication":12}}', null, null);
insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
values (gen_random_uuid(), 'payment.reported', '$cN', '$owner', '{"note":"n"}', clock_timestamp(), 'not-a-digest', 99, repeat('1', 64), repeat('3', 64));
-- Codex T200: wrong JSON types ahead of casts/array expansion, the method
-- vocabulary, aal, and a recorded null counterparty_name.
select pg_temp.ev('$cN', 'dod.consent_recorded', '{"counterparty_name":null,"dod_items":"not-an-array"}', null, null);
select pg_temp.ev('$cN', 'dod.consent_recorded', '{"counterparty_name":{"n":"nested-name@example.test"},"dod_items":{"0":"x"}}', null, null);
select pg_temp.ev('$cN', 'contract.initiated', '{"step":"abc","title":"T"}', null, null);
select pg_temp.ev('$cN', 'payment.acknowledged', '{"note":"n","_authentication":{"assurance":"bearer_capability","recent_authentication_window_seconds":"abc"}}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":"n","_authentication":{"assurance":"account_session","method":"arbitrary_label","aal":"aal1"}}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":"n","_authentication":{"assurance":"account_session","credential":"account_jwt","method":"email_change","aal":"aal2","seconds_since_authentication":3,"recent_authentication":true,"recent_authentication_window_seconds":300}}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":"n","_authentication":{"assurance":"account_session","method":"sso/saml","aal":"aal1"}}', null, null);
select pg_temp.ev('$cN', 'payment.reported', '{"note":"n","_authentication":{"assurance":"account_session","method":"otp","aal":"aal3"}}', null, null);
SQL
read() { q "select public.read_delegated_owner_deal('$1', '$2', $3)${4:-}"; }

# ── Authority: every refusal, and refusals carry nothing ────────────────────
expect 'live read grant: ok' ok "$(read "$cA" "$gR" "$(h 1)" "->>'status'")"
expect 'wrong deal (cA grant on cB)' grant_unknown "$(read "$cB" "$gR" "$(h 1)" "->>'status'")"
expect 'swapped grant (cB grant on cA)' grant_unknown "$(read "$cA" "$gB" "$(h 3)" "->>'status'")"
expect 'unknown grant' grant_unknown "$(read "$cA" cccccccc-0000-4000-8000-0000000000ff "$(h 1)" "->>'status'")"
expect 'absent deal' grant_unknown "$(read aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9 "$gR" "$(h 1)" "->>'status'")"
expect 'wrong secret' secret_mismatch "$(read "$cA" "$gR" "$(h 2)" "->>'status'")"
expect 'malformed hash' malformed "$(read "$cA" "$gR" "'ABC'" "->>'status'")"
expect 'null credential' malformed "$(q "select public.read_delegated_owner_deal('$cA', null, $(h 1))->>'status'")"
expect 'counterpart_account issuer' issuer_kind "$(read "$cA" "$gK" "$(h 6)" "->>'status'")"
expect 'owner changed after issuance' issuer_not_owner "$(read "$cO" "$gO" "$(h 7)" "->>'status'")"
expect 'missing read scope (write-only grant)' scope "$(read "$cA" "$gW" "$(h 2)" "->>'status'")"
expect 'revoked' revoked "$(read "$cA" "$gX" "$(h 4)" "->>'status'")"
expect 'expired' expired "$(read "$cA" "$gT" "$(h 5)" "->>'status'")"
for case in "$cB $gR 1" "$cA $gR 2" "$cA $gK 6" "$cO $gO 7" "$cA $gW 2" "$cA $gX 4" "$cA $gT 5"; do
  set -- $case
  expect "refusal ($2 on $1) is {status} alone" status "$(q "select string_agg(k, ',') from jsonb_object_keys(public.read_delegated_owner_deal('$1', '$2', $(h "$3"))) k")"
done
# psql -v VERBOSITY=verbose prints the SQLSTATE, so the refusal is pinned, not any error.
err() { docker exec -i "$container" psql -X -qAt -U postgres -d "$db" -v VERBOSITY=verbose <<< "$1" 2>&1 | grep -oE 'ERROR: +[0-9A-Z]{5}' | head -1 | grep -oE '[0-9A-Z]{5}$' || echo none; }
expect 'REPEATABLE READ is refused with TF005' TF005 "$(err "begin isolation level repeatable read; select public.read_delegated_owner_deal('$cA', '$gR', $(h 1)); commit;")"
expect 'SERIALIZABLE is refused with TF005' TF005 "$(err "begin isolation level serializable; select public.read_delegated_owner_deal('$cA', '$gR', $(h 1)); commit;")"

# ── Gate independence: read never looks at the v5 write gate ────────────────
expect 'the gate is closed' f "$(q "select open from private.v5_write_gate")"
expect 'closed gate: read ok' ok "$(read "$cA" "$gR" "$(h 1)" "->>'status'")"
expect 'missing gate (disposable): read ok' ok "$(q "begin; alter table private.v5_write_gate disable trigger user; delete from private.v5_write_gate;
  select public.read_delegated_owner_deal('$cA', '$gR', $(h 1))->>'status'; rollback;")"
expect 'the gate row is back after the rollback' 1 "$(q "select count(*) from private.v5_write_gate")"

# ── ACLs: direct RPC and helper, effective (inherited) privileges ───────────
for r in anon authenticated; do
  expect "$r cannot execute the read RPC (42501)" 42501 "$(err "begin; set local role $r; select public.read_delegated_owner_deal('$cA', '$gR', $(h 1)); commit;")"
done
expect 'service_role executes the read RPC' ok "$(q "begin; set local role service_role; select public.read_delegated_owner_deal('$cA', '$gR', $(h 1))->>'status'; commit;")"
for r in anon authenticated service_role; do
  expect "$r cannot execute the read helper (42501)" 42501 "$(err "begin; set local role $r; select * from private.resolve_owner_read_grant('$cA', '$gR', $(h 1)); commit;")"
done
expect 'non-superuser roles that can EXECUTE the RPC (inherited included)' postgres,service_role \
  "$(q "select string_agg(rolname, ',' order by rolname) from pg_roles where not rolsuper and rolname !~ '^pg_'
        and has_function_privilege(oid, 'public.read_delegated_owner_deal(uuid,uuid,text)', 'EXECUTE')")"
expect 'non-superuser roles that can EXECUTE the helper (inherited included)' postgres \
  "$(q "select string_agg(rolname, ',' order by rolname) from pg_roles where not rolsuper and rolname !~ '^pg_'
        and has_function_privilege(oid, 'private.resolve_owner_read_grant(uuid,uuid,text)', 'EXECUTE')")"
expect 'both are SECURITY DEFINER with an empty search_path' 2 "$(q "select count(*) from pg_proc p where p.oid in
  ('public.read_delegated_owner_deal(uuid,uuid,text)'::regprocedure, 'private.resolve_owner_read_grant(uuid,uuid,text)'::regprocedure)
  and p.prosecdef and 'search_path=\"\"' = any(p.proconfig)")"

# ── Bypass inventory with the read helper and RPC present ──────────────────
psql_pg < tests/sql/entry_agent_credentials_inventory.sql > "$work/inventory.out" 2>&1 || { cat "$work/inventory.out" >&2; exit 1; }
grep -i 'fail\|error' "$work/inventory.out" && { echo 'inventory reported a failure' >&2; exit 1; }
expect 'inventory: the read RPC does not name the credential table' 0 \
  "$(q "select count(*) from pg_proc where oid = 'public.read_delegated_owner_deal(uuid,uuid,text)'::regprocedure and prosrc ilike '%entry_agent_credentials%'")"
echo 'PASS bypass inventory with the row 5 read present'

# ── Parity with the row 4 resolver on the common checks ─────────────────────
#    gP carries both scopes, so scope never differs; the write resolver runs
#    with p_for_insert = false (no gate), as replay does.
for case in "$cA $gP c ok" "$cB $gP c grant_unknown" "$cA $gP 1 secret_mismatch" "$cA $gK 6 issuer_kind" \
            "$cO $gO 7 issuer_not_owner" "$cA $gX 4 revoked" "$cA $gT 5 expired"; do
  set -- $case
  w="$(q "select status from private.resolve_entry_agent_grant('$1', '$2', $(h "$3"), 'payment.acknowledged', false)")"
  r="$(q "select status from private.resolve_owner_read_grant('$1', '$2', $(h "$3"))")"
  expect "parity $4: read helper" "$4" "$r"
  expect "parity $4: write resolver agrees" "$4" "$w"
done

# ── `read` cannot enter append or replay ────────────────────────────────────
expect 'replay with type read is refused by the write allowlist' allowlist \
  "$(q "select public.replay_delegated_event('$cA', '$gR', $(h 1), 'read', null)->>'status'")"
expect 'a read-only grant cannot authorize a write type' scope \
  "$(q "select public.replay_delegated_event('$cA', '$gR', $(h 1), 'payment.acknowledged', null)->>'status'")"

# ── Materialization: projection, order, withheld fields ─────────────────────
out="$(read "$cA" "$gR" "$(h 1)")"
j() { jq -r "$1" <<< "$out"; }
expect 'top-level keys' 'authorized_at,contract,events,read_boundary,status' "$(j 'keys | join(",")')"
expect 'contract projection keys' 'amount_jpy,amount_minor,currency,deadline,dod,earner_display_name,id,performed_by,project_name,state' "$(j '.contract | keys | join(",")')"
expect 'no contact, invite, guest or payment-provider value anywhere' 0 \
  "$(grep -cE '@|bbbbbbbb-bbbb|dddddddd-dddd|pi_secret|idem-secret|tsa-token|UA/1|private_note|_extra|_invited_recipient|_claimed_identity"|_shown_terms' <<< "$out" || true)"
expect 'event keys (account actor)' 'actor_id,agreement_hash,canonical_inputs_complete,contract_id,created_at,credential_id,dod_hash,event_hash,hash_version,id,issuer_kind,payload,payload_hash,prev_event_hash,timestamp_token_present,type,withheld' \
  "$(j '.events[0] | keys | join(",")')"
expect 'events in (created_at, id) order' "$(q "select string_agg(id::text, ',' order by created_at, id) from public.events where contract_id = '$cA'")" \
  "$(j '[.events[].id] | join(",")')"
expect 'initiated: statement + scalar metadata kept, nested _authentication withheld' '_actor_role,_auth_method,step,title|payload._authentication|true' \
  "$(j '.events[0] | (.payload | keys | join(",")) + "|" + (.withheld | join(",")) + "|" + (.canonical_inputs_complete | tostring)')"
expect 'timestamp token: presence only' 'true,false' "$(j '[.events[0,1].timestamp_token_present] | map(tostring) | join(",")')"
expect 'guest acceptance: no actor_id, out-of-schema snapshot withheld, inputs incomplete' 'false|actor_id,payload._agreement|false' \
  "$(j '.events[1] | (has("actor_id") | tostring) + "|" + (.withheld | join(",")) + "|" + (.canonical_inputs_complete | tostring)')"
expect 'guest acceptance: name, items and scalar metadata only' '_actor_role,_claimed_identity_verified,counterparty_name,dod_items' "$(j '.events[1].payload | keys | join(",")')"
expect 'contract.accepted is not the acceptance: no _agreement' '_role_in_agreement,step|' "$(j '.events[2] | (.payload | keys | join(",")) + "|" + (.withheld | join(","))')"
expect 'payment: in-schema _authentication kept verbatim' "$(q "select payload->'_authentication' from public.events where contract_id = '$cA' and type = 'payment.reported'" | jq -S -c .)" \
  "$(j '.events[3].payload._authentication' | jq -S -c .)"
expect 'payment keeps note, the identity flag and _authentication' '_authentication,_claimed_identity_verified,note' "$(j '.events[3].payload | keys | join(",")')"
expect 'unknown type: metadata only' '_actor_role' "$(j '.events[4].payload | keys | join(",")')"
expect 'dispute: _agreement dropped, non-scalar _actor_role withheld' 'reason|payload._actor_role' "$(j '.events[5] | (.payload | keys | join(",")) + "|" + (.withheld | join(","))')"
expect 'boundary: complete trail' '6,6,false' "$(j '.read_boundary | [.total_count, .returned_count, .truncated] | map(tostring) | join(",")')"
expect 'boundary: returned_bytes is the event array text length' "$(q "select octet_length((public.read_delegated_owner_deal('$cA', '$gR', $(h 1))->'events')::text)")" "$(j '.read_boundary.returned_bytes')"
expect 'boundary: tail is the last event' "$(j '.events[-1].id')" "$(j '.read_boundary.tail.id')"
expect 'boundary: anchor is dod.consent_recorded at sequence 1, in prefix, one acceptance' "$(j '.events[1].id'),1,true,1" \
  "$(j '.read_boundary | [.acceptance_anchor.event_id, .acceptance_anchor.sequence, .acceptance_anchor.in_prefix, .acceptance_count] | map(tostring) | join(",")')"
expect 'a second acceptance: the anchor stays the first, count 2' "$(j '.events[1].id'),2" "$(q "begin;
  insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
  values (gen_random_uuid(), 'dod.consent_recorded', '$cA', '$owner', '{}', clock_timestamp(), repeat('9', 64), 4, repeat('1', 64), repeat('3', 64));
  select (r->'read_boundary'->'acceptance_anchor'->>'event_id') || ',' || (r->'read_boundary'->>'acceptance_count')
  from (select public.read_delegated_owner_deal('$cA', '$gR', $(h 1)) r) s; rollback;" | tail -1)"

# Equal created_at: id breaks the tie (monotonic trigger off, disposable).
expect 'equal created_at: ordered by id' 'aaaaaaaa-0000-4000-8000-000000000001,ffffffff-0000-4000-8000-000000000001' "$(q "begin;
  alter table public.events disable trigger events_require_monotonic_created_at;
  insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
  select x::uuid, 'payment.reported', '$cE', '$owner', '{}', '2030-01-01T00:00:00Z', repeat('e', 64), 4, repeat('1', 64), repeat('3', 64)
  from unnest(array['ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001']) x;
  select string_agg(e->>'id', ',') from jsonb_array_elements(public.read_delegated_owner_deal('$cE', '$gE', $(h 8))->'events') e;
  rollback;")"

# Empty trail.
out="$(read "$cE" "$gE" "$(h 8)")"
expect 'empty trail: ok, no events, exact zero, "[]" bytes, no tail, anchor or acceptance' 'ok,0,0,0,2,false,null,null,0' \
  "$(j '[.status, (.events | length), .read_boundary.total_count, .read_boundary.returned_count, .read_boundary.returned_bytes, .read_boundary.truncated, .read_boundary.tail, .read_boundary.acceptance_anchor, .read_boundary.acceptance_count] | map(tostring) | join(",")')"

# ── Caps: 500 events, then 1 MiB, from one materialization ──────────────────
q "insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
   select gen_random_uuid(), 'payment.reported', '$cL', '$owner', '{\"note\":\"n\"}', '2030-01-01T00:00:00Z'::timestamptz + make_interval(secs => i),
     encode(sha256(i::text::bytea), 'hex'), 4, repeat('1', 64), repeat('3', 64) from generate_series(1, 501) i" > /dev/null
out="$(read "$cL" "$gL" "$(h b)")"
expect '501 events: 500 returned, exact total, truncated' '500,501,500,true' \
  "$(j '[(.events | length), .read_boundary.total_count, .read_boundary.returned_count, .read_boundary.truncated] | map(tostring) | join(",")')"
expect '501 events: tail is the 500th' "$(q "select id from public.events where contract_id = '$cL' order by created_at, id offset 499 limit 1")" "$(j '.read_boundary.tail.id')"
expect '501 events: no acceptance anchor' 'null,0' "$(j '[.read_boundary.acceptance_anchor, .read_boundary.acceptance_count] | map(tostring) | join(",")')"
expect '501 events: returned_bytes is the array text length' "$(q "select octet_length((public.read_delegated_owner_deal('$cL', '$gL', $(h b))->'events')::text)")" "$(j '.read_boundary.returned_bytes')"
# An acceptance (by a guest actor) beyond the prefix is reported outside it.
q "insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
   values (gen_random_uuid(), 'dod.consent_recorded', '$cL', 'guest:$guest', '{\"counterparty_email\":\"$guest\"}', '2031-01-01T00:00:00Z', repeat('f', 64), 4, repeat('1', 64), repeat('3', 64))" > /dev/null
expect 'anchor outside the prefix: sequence 501, in_prefix false, one acceptance' '501,false,1' \
  "$(q "select (b->'acceptance_anchor'->>'sequence') || ',' || (b->'acceptance_anchor'->>'in_prefix') || ',' || (b->>'acceptance_count')
        from (select public.read_delegated_owner_deal('$cL', '$gL', $(h b))->'read_boundary' b) s")"
expect 'anchor outside the prefix: no contact address in the read' 0 "$(read "$cL" "$gL" "$(h b)" | grep -c '@' || true)"
# Byte cap, at the exact edge with 3-byte UTF-8 text. Three ~300 kB notes, then
# a fourth sized so the event array text is exactly 1 MiB (kept), then one byte
# more (cut at the row boundary). Savepoints, because events are append-only.
fill() { echo "repeat('あ', ($1) / 3) || repeat('x', ($1) % 3)"; }
ev4() { echo "insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
  values ('eeeeeeee-0000-4000-8000-000000000004', 'payment.reported', '$cE', '$owner', jsonb_build_object('note', $1),
    '2030-01-01T00:00:04Z', repeat('4', 64), 4, repeat('1', 64), repeat('3', 64));"; }
rb="(select public.read_delegated_owner_deal('$cE', '$gE', $(h 8)) r) s"
edge="$(psql_pg <<SQL
begin;
insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
select gen_random_uuid(), 'payment.reported', '$cE', '$owner', jsonb_build_object('note', repeat('あ', 100000)),
  '2030-01-01T00:00:00Z'::timestamptz + make_interval(secs => i), encode(sha256(i::text::bytea), 'hex'), 4, repeat('1', 64), repeat('3', 64)
from generate_series(1, 3) i;
savepoint s;
$(ev4 "''")
select (r->'read_boundary'->>'returned_bytes')::bigint as b0 from $rb \gset
rollback to savepoint s;
$(ev4 "$(fill "1048576 - :b0")")
select concat_ws(',', r->'read_boundary'->>'returned_count', r->'read_boundary'->>'returned_bytes', octet_length((r->'events')::text),
  r->'read_boundary'->>'truncated') from $rb;
rollback to savepoint s;
$(ev4 "$(fill "1048576 - :b0 + 1")")
select concat_ws(',', r->'read_boundary'->>'returned_count', (r->'read_boundary'->>'returned_bytes')::bigint < 1048576,
  octet_length((r->'events')::text) = (r->'read_boundary'->>'returned_bytes')::bigint, r->'read_boundary'->>'truncated',
  r->'read_boundary'->'tail'->>'id' <> 'eeeeeeee-0000-4000-8000-000000000004') from $rb;
rollback;
SQL
)"
expect 'byte cap: an array of exactly 1 MiB (UTF-8) is kept whole' '4,1048576,1048576,false' "$(sed -n 1p <<< "$edge")"
expect 'byte cap: one byte more cuts the fourth row' '3,t,t,true,t' "$(sed -n 2p <<< "$edge")"

# ── A real writer-built v5 row after a legacy predecessor ───────────────────
psql_pg > /dev/null <<SQL
insert into public.events (id, type, contract_id, actor_id, payload, created_at, event_hash, hash_version, payload_hash, dod_hash)
values (gen_random_uuid(), 'contract.initiated', '$cV', '$owner', '{"step":1}', clock_timestamp(), repeat('7', 64), 4, repeat('1', 64), repeat('3', 64));
alter table public.events drop constraint events_v5_writes_disabled;
update private.v5_write_gate set open = true;
do \$\$
declare v_id uuid := gen_random_uuid(); v_at timestamptz := date_trunc('milliseconds', clock_timestamp()); r jsonb;
begin
  r := public.append_delegated_event('$cV', '$gA', repeat('a', 64), 'creator', '{"dod":["test"],"agreement":null}',
    jsonb_build_object('id', v_id, 'type', 'payment.acknowledged', 'contract_id', '$cV', 'actor_id', '$owner',
      'dod_hash', repeat('2', 64), 'created_at', to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'prev_event_hash', repeat('7', 64),
      'payload', jsonb_build_object('note', 'paid', '_actor_role', 'earner', '_role_in_agreement', 'performer',
        '_auth_method', 'entry_agent_grant', '_authentication', private.v5_grant_authentication()),
      'payload_hash', repeat('1', 64), 'agreement_hash', null,
      'event_hash', encode(sha256(convert_to(private.v5_outer_canonical(v_id, 'payment.acknowledged', '$cV', '$owner',
         repeat('2', 64), v_at, repeat('7', 64), repeat('1', 64), null, '$gA', 'owner_account'), 'UTF8')), 'hex'),
      'idempotency_key', 'v5-idem'));
  if r->>'status' <> 'appended' then raise exception 'seed v5 append: %', r; end if;
end \$\$;
update private.v5_write_gate set open = false;
SQL
out="$(read "$cV" "$gV" "$(h 9)")"
expect 'v5 row: authority inputs carried' "5,$gA,owner_account" "$(j '.events[1] | [.hash_version, .credential_id, .issuer_kind] | map(tostring) | join(",")')"
expect 'v5 row: event_hash and prev link as stored' "$(q "select event_hash || ',' || prev_event_hash from public.events where contract_id = '$cV' and hash_version = 5")" "$(j '.events[1] | .event_hash + "," + .prev_event_hash')"
expect 'v5 row: recorded label kept, idempotency key withheld' 'entry_agent_grant,0' "$(j '.events[1].payload._auth_method'),$(grep -c 'v5-idem' <<< "$out" || true)"
expect 'legacy predecessor: no authority values' 'null,null' "$(j '.events[0] | [.credential_id, .issuer_kind] | map(tostring) | join(",")')"
expect 'the read wrote nothing (no ticket, events unchanged)' '0,2' "$(q "select (select count(*) from private.v5_write_tickets) || ',' || (select count(*) from public.events where contract_id = '$cV')")"


# ── A genuine invite acceptance, then a v5 event (the real TS writers) ──────
fx() { deno run --no-lock --quiet tests/sql/owner_read_fixture.ts "$@"; }
deno_ts() { deno run --no-lock --quiet tests/sql/delegated_proposal.ts "$@"; }
acc="$(q "select jsonb_build_object('contract', to_jsonb(k), 'email', '$guest') from public.contracts k where id = '$cG'" | fx acceptance)"
psql_pg -v acc="$acc" > /dev/null <<'SQL'
insert into public.events select * from jsonb_populate_record(null::public.events, :'acc'::jsonb);
SQL
q "update public.contracts set state = 'TERMS_ACCEPTED', hirer_email = '$guest' where id = '$cG'" > /dev/null
prop="$(q "select jsonb_build_object('contract', to_jsonb(k), 'tip', (select event_hash from public.events where contract_id = '$cG'),
  'credentialId', '$gH', 'type', 'payment.acknowledged', 'payload', '{\"note\":\"paid after acceptance\"}'::jsonb, 'key', 'g-v5', 'acceptedVersion', 1)
  from public.contracts k where id = '$cG'" | deno_ts build)"
expect 'genuine trail: the v5 event appends after the acceptance' appended "$(psql_pg -v prop="$prop" <<SQL
update private.v5_write_gate set open = true;
select public.append_delegated_event('$cG', '$gH', $(h e), p->>'performed_by', p->'hashed_inputs', p->'event')->>'status'
  from (select :'prop'::jsonb p) s;
update private.v5_write_gate set open = false;
SQL
)"
out="$(read "$cG" "$gG" "$(h d)")"
expect 'genuine trail: acceptance then v5, anchor at 0 in the prefix' 'dod.consent_recorded,payment.acknowledged|0,true,1' \
  "$(j '([.events[].type] | join(",")) + "|" + ([.read_boundary.acceptance_anchor.sequence, .read_boundary.acceptance_anchor.in_prefix, .read_boundary.acceptance_count] | map(tostring) | join(","))')"
expect 'genuine acceptance: guest actor withheld, inputs incomplete, nothing else withheld' 'false|actor_id|false' \
  "$(j '.events[0] | (has("actor_id") | tostring) + "|" + (.withheld | join(",")) + "|" + (.canonical_inputs_complete | tostring)')"
expect 'genuine acceptance: approved payload keys only' '_actor_role,_agreement,_auth_method,_authentication,_claimed_identity_verified,_role_in_agreement,counterparty_name,dod_items' \
  "$(j '.events[0].payload | keys | join(",")')"
expect 'genuine acceptance: the snapshot is the stored one, verbatim' \
  "$(q "select payload->'_agreement' from public.events where contract_id = '$cG' and type = 'dod.consent_recorded'" | jq -S -c .)" \
  "$(j '.events[0].payload._agreement' | jq -S -c .)"
expect 'genuine acceptance: the snapshot hashes (stableStringify + SHA-256) to the projected agreement_hash' "$(j '.events[0].agreement_hash')" \
  "$(j '.events[0].payload._agreement' | fx digest)"
expect 'genuine acceptance: and that is the stored digest' "$(q "select agreement_hash from public.events where contract_id = '$cG' and type = 'dod.consent_recorded'")" "$(j '.events[0].agreement_hash')"
expect 'genuine trail: no contact address anywhere in the read' 0 "$(grep -c '@' <<< "$out" || true)"
expect 'genuine v5: owner actor carried, inputs complete, nothing withheld' "$owner|true|" \
  "$(j '.events[1] | .actor_id + "|" + (.canonical_inputs_complete | tostring) + "|" + (.withheld | join(","))')"
expect 'genuine v5: recomputes from the projected inputs alone' "$(j '.events[1].event_hash')" \
  "$(psql_pg -v e="$(j '.events[1] | tojson')" <<'SQL'
select encode(sha256(convert_to(private.v5_outer_canonical((e->>'id')::uuid, e->>'type', (e->>'contract_id')::uuid, (e->>'actor_id')::uuid,
  e->>'dod_hash', (e->>'created_at')::timestamptz, e->>'prev_event_hash', e->>'payload_hash', e->>'agreement_hash',
  (e->>'credential_id')::uuid, e->>'issuer_kind'), 'UTF8')), 'hex') from (select :'e'::jsonb e) s;
SQL
)"

# ── Statement-key parity with the guest allowlist ───────────────────────────
expect 'statement keys equal guestEventView PAYLOAD_ALLOWLIST minus counterparty_email' "$(fx allowlist | jq -S -c .)" \
  "$(q "select private.owner_read_statement_keys()" | jq -S -c .)"
for f in 'owner_read_statement_keys()' 'owner_read_snapshot_ok(jsonb)' 'owner_read_count_ok(jsonb)' 'owner_read_value_ok(text,jsonb)' \
         'owner_read_authentication_ok(jsonb)' 'owner_read_payload(text,jsonb)'; do
  expect "no client role or service_role can execute private.$f" '' \
    "$(q "select string_agg(rolname, ',') from pg_roles where rolname in ('anon', 'authenticated', 'service_role') and has_function_privilege(oid, 'private.$f', 'EXECUTE')")"
done

# ── `read` cannot enter append either (both row 4 RPCs pinned) ──────────────
app="$(q "select jsonb_build_object('contract', to_jsonb(k), 'tip', null, 'credentialId', '$gR', 'type', 'payment.acknowledged',
  'payload', '{\"note\":\"x\"}'::jsonb, 'key', null, 'acceptedVersion', null) from public.contracts k where id = '$cA'" | deno_ts build)"
appended() { psql_pg -v prop="$app" -v t="$1" <<SQL
select public.append_delegated_event('$cA', '$gR', $(h 1), p->>'performed_by', p->'hashed_inputs', jsonb_set(p->'event', '{type}', to_jsonb(:'t'::text)))->>'status'
  from (select :'prop'::jsonb p) s;
SQL
}
expect 'append under a read-only grant is refused (scope)' scope "$(appended payment.acknowledged)"
expect 'append of type read is refused before authority (malformed type)' binding_mismatch "$(appended read)"
expect 'the refused appends wrote nothing' 6 "$(q "select count(*) from public.events where contract_id = '$cA'")"

# ── Value domains under approved keys (Codex T199) ──────────────────────────
out="$(read "$cN" "$gN" "$(h f)")"
row() { j ".events[$1] | (.payload | keys | join(\",\")) + \"|\" + (.withheld | join(\",\"))"; }
expect 'nested object under reason; unsupported _actor_role string' '|payload._actor_role,payload.reason' "$(row 0)"
expect 'nested object inside dod_items; contact under _auth_method; unknown role' 'counterparty_name|payload._auth_method,payload._role_in_agreement,payload.dod_items' "$(row 1)"
expect 'object step, array title, non-digit budgetPoints' '|payload.budgetPoints,payload.step,payload.title' "$(row 2)"
expect 'valid step, title and digit-string budgetPoints kept' 'budgetPoints,step,title|' "$(row 3)"
expect 'fractional rating withheld' '|payload.rating' "$(row 4)"
expect 'integer rating kept' 'rating|' "$(row 5)"
expect 'contact under _authentication.credential: withheld whole; free-text note kept' 'note|payload._authentication' "$(row 6)"
expect 'contact under _authentication.act_binding_mechanism: withheld whole' 'note|payload._authentication' "$(row 7)"
expect 'act_bound_authentication true: withheld whole' 'note|payload._authentication' "$(row 8)"
expect 'the recorded grant assurance crosses whole' 'payload._authentication: true|' \
  "$(j '.events[9] | "payload._authentication: " + ((.payload._authentication == {"assurance":"bearer_capability","credential":"entry_agent_grant","method":null,"aal":null,"seconds_since_authentication":null,"recent_authentication":false,"recent_authentication_window_seconds":300,"act_bound_authentication":false,"act_binding_mechanism":null}) | tostring) + "|" + (.withheld | join(","))')"
expect 'nested note withheld; a session assurance with method and age crosses' '_authentication|payload.note' "$(row 10)"
expect 'no structural canary crosses (nested-, meta-, cred@, mech@, admin-at@)' 0 \
  "$(grep -cE 'nested-|meta-auth|cred@|mech@|admin-at@' <<< "$out" || true)"
expect 'the only address left is the free-text note (statement content, by design)' 'text-note@example.test' \
  "$(grep -oE '[A-Za-z0-9._-]+@[A-Za-z0-9.-]+' <<< "$out" | sort -u | paste -sd, -)"
expect 'withheld lists only fixed approved names, never a party key' 0 \
  "$(j '[.events[].withheld[]] | map(select(. != "actor_id" and (test("^payload\\.(_actor_role|_role_in_agreement|_auth_method|_claimed_identity_verified|_authentication|_agreement|title|note|reason|counterparty_name|step|rating|budgetPoints|dod_items)$") | not))) | length')"

expect 'the read over malformed rows succeeds and returns every row' 20 "$(j '.events | length')"
expect 'non-array dod_items withheld; recorded null counterparty_name kept' 'counterparty_name|payload.dod_items' "$(row 12)"
expect 'the recorded null itself crosses' 'null' "$(j '.events[12].payload.counterparty_name')"
expect 'object dod_items and structured counterparty_name withheld' '|payload.counterparty_name,payload.dod_items' "$(row 13)"
expect 'non-numeric string step withheld; title kept' 'title|payload.step' "$(row 14)"
expect 'string recency window: assurance withheld whole' 'note|payload._authentication' "$(row 15)"
expect 'identifier-shaped unsupported method: assurance withheld whole' 'note|payload._authentication' "$(row 16)"
expect 'supported non-otp method (email_change) with aal2 crosses verbatim' 'true|' \
  "$(j '.events[17] | ((.payload._authentication == {"assurance":"account_session","credential":"account_jwt","method":"email_change","aal":"aal2","seconds_since_authentication":3,"recent_authentication":true,"recent_authentication_window_seconds":300}) | tostring) + "|" + (.withheld | join(","))')"
expect 'slashed method (sso/saml) crosses verbatim' 'sso/saml|' "$(j '.events[18] | .payload._authentication.method + "|" + (.withheld | join(","))')"
expect 'aal3 is not a recorded level: assurance withheld whole' 'note|payload._authentication' "$(row 19)"
expect 'no T200 canary crosses (nested-name, arbitrary_label, not-an-array, abc)' 0 \
  "$(grep -cE 'nested-name|arbitrary_label|not-an-array|"abc"' <<< "$out" || true)"

# canonical_inputs_complete is projection completeness, not recomputability.
expect 'unsupported-format UUID-actor row: complete projection, stored format as is' 'true|99|not-a-digest' \
  "$(j '.events[11] | (.canonical_inputs_complete | tostring) + "|" + (.hash_version | tostring) + "|" + .event_hash')"
expect 'the deliberately withheld legacy guest input: incomplete' 'false' \
  "$(read "$cA" "$gR" "$(h 1)" "->'events'->1->>'canonical_inputs_complete'")"
expect 'the window total is gone from the lock-held work' 0 \
  "$(q "select count(*) from pg_proc where oid = 'public.read_delegated_owner_deal(uuid,uuid,text)'::regprocedure and prosrc ilike '%count(*) over ()%'")"

echo 'ALL PASS'
