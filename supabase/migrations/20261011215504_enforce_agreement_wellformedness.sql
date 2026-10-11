-- Approved structural constraints for new agreements; already applied to E2E and production.
--
-- Well-formedness constraints for a proposed agreement.
--
-- WHY CONSTRAINTS AT ALL, GIVEN THERE WILL BE AN RPC
-- A future server-controlled creation endpoint may replace direct INSERT; They are
-- still worth having: they are the backstop that survives a bug in the RPC, a
-- future second write path, and anyone operating with elevated rights. The RPC
-- gives good error messages; the constraints give a guarantee.
--
-- WHAT IS NOT HERE
-- The deadline floor. A CHECK is re-evaluated on every later UPDATE, so
-- `deadline >= current_date` would hold at creation and then fail forever
-- afterwards — tomorrow's deadline becomes yesterday's and the next state
-- transition on the row raises. It also reads `current_date` in UTC, which is a
-- calendar day ahead of a user in UTC-7, so it would refuse that user's own
-- "today". The rule belongs in the creation path, where "when the row is
-- written" can actually be expressed. See docs/proposals/server-side-agreement-rules.md.
--
-- The amount ceiling. TRUST_LADDER specifies contractLimit: null — explicitly
-- unlimited — at level 10, so a ceiling here would make that tier
-- undeliverable. A cap is a per-account policy check, not well-formedness.
--
-- COMPATIBILITY
-- Every predicate below was counted against live data on 2026-10-11 before
-- being written: 1321 production contracts, 2051 dod elements, and 145 E2E
-- contracts. Zero violations of any of them. The whole file is additionally
-- applied to a throwaway local PostgreSQL 17 by `npm run check:sql-draft`,
-- which also asserts that it agrees with agreementRules.ts case by case, so
-- "this SQL compiles" is a test result and not a belief. So no NOT VALID, no backfill, no
-- exceptions list. Rollback is a DROP CONSTRAINT and loses nothing.
--
-- The length bounds are UNRATIFIED: no prior specification sets them, and they
-- are headroom an order of magnitude clear of every observed value (project
-- name 44, dod 3 items, dod element 23, display name 28). Raising one later is
-- backwards compatible; lowering one is not.

begin;

-- ── project name ────────────────────────────────────────────────────────────
alter table contracts drop constraint if exists contracts_project_name_check;
alter table contracts
  add constraint contracts_project_name_check
  check (btrim(project_name) <> '' and length(project_name) <= 500);

-- ── definition of done ──────────────────────────────────────────────────────
-- The terms themselves: dod_hash is derived from this server-side and is cited
-- by every event in the chain, so an empty or malformed one produces a chain
-- whose every link points at nothing.
--
-- WHY THIS IS NOT THE OBVIOUS `NOT EXISTS (SELECT ... jsonb_array_elements)`
-- An earlier draft of this file used exactly that, and it does not compile:
--
--   ERROR:  0A000: cannot use subquery in check constraint
--
-- A CHECK constraint may not contain a subquery, and jsonb_array_elements is
-- set-returning, so per-element inspection has to be expressed another way.
-- Verified on PostgreSQL 17.11 before this rewrite.
--
-- WHY `strict`, WHICH IS NOT OPTIONAL HERE
-- SQL/JSON path defaults to lax mode, which FLATTENS nested arrays. In lax
-- mode `$[*]` over '[["nested"]]' yields the string "nested", so a nested
-- array passes a test for "every element is a string" — measured, it was
-- accepted. `strict` stops the unwrapping and the same input is refused.
--
-- WHAT THIS CANNOT EXPRESS, AND WHERE IT WENT INSTEAD
-- A per-element maximum length. like_regex refuses a repetition count that
-- large ("invalid regular expression: invalid repetition count(s)"), so the
-- bound below is on the serialized size of the whole `dod` — which is the
-- quantity that actually matters for something hashed into a chain forever.
-- The per-element limit stays in agreementRules.ts and the creation path.
--
-- CONSIDERED AND REJECTED: an IMMUTABLE helper function. It expresses every
-- rule exactly, including per-element length, and reads far better. It can
-- also be silently disarmed: `CREATE OR REPLACE FUNCTION dod_well_formed(jsonb)
-- ... AS $$ SELECT true $$` leaves the constraint in place, under the same
-- name, with no ALTER TABLE and no revalidation, and the table then accepts
-- anything. Demonstrated live. An inlined expression has nothing to redefine,
-- so the readability is not worth the extra way to turn the rule off quietly.
alter table contracts drop constraint if exists contracts_dod_shape_check;
alter table contracts
  add constraint contracts_dod_shape_check
  check (
    jsonb_typeof(dod) = 'array'
    and jsonb_array_length(dod) between 1 and 50
    -- every element is a string …
    and not jsonb_path_match(dod, 'strict exists($[*] ? (@.type() <> "string"))')
    -- … and none of them is blank
    and not jsonb_path_match(dod, 'strict exists($[*] ? (@ like_regex "^[[:space:]]*$"))')
    -- total serialized size, standing in for a per-element cap
    and length(dod::text) <= 20000
  );

-- ── amount ──────────────────────────────────────────────────────────────────
-- Positive only. JPY has no minor unit and the column is already `integer`, so
-- there is nothing to say about precision.
alter table contracts drop constraint if exists contracts_amount_positive_check;
alter table contracts
  add constraint contracts_amount_positive_check
  check (amount_jpy > 0);

-- ── currency ────────────────────────────────────────────────────────────────
-- 1466 of 1466 rows are JPY and the column is named amount_jpy. A second
-- currency is a schema change and a product decision, not a relaxation of this.
alter table contracts drop constraint if exists contracts_currency_check;
alter table contracts
  add constraint contracts_currency_check
  check (currency = 'JPY');

-- ── deadline shape only ─────────────────────────────────────────────────────
-- The column is already `date`, so the format is enforced by the type. It stays
-- NULLABLE: 957 of 1321 production contracts have no deadline, and an agreement
-- without one is a real agreement. No constraint is added here at all; this
-- comment exists so that nobody reads the omission as an oversight.

-- ── addresses ───────────────────────────────────────────────────────────────
-- Deliberately permissive: it rejects what is certainly not an address and
-- nothing more. A false rejection is worse than a false acceptance here,
-- because this address is the only handle on a counterparty who has no account.
-- A typo'd but well-shaped address is already handled honestly, by being
-- recorded as _claimed_identity_verified: false.
--
-- hirer_email is included because it is written by accept_invitation from input
-- the guest typed, and it is the field the whole claimed-identity distinction
-- rests on.
alter table contracts drop constraint if exists contracts_invited_email_shape_check;
alter table contracts
  add constraint contracts_invited_email_shape_check
  check (invited_hirer_email is null
         or invited_hirer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

alter table contracts drop constraint if exists contracts_hirer_email_shape_check;
alter table contracts
  add constraint contracts_hirer_email_shape_check
  check (hirer_email is null
         or hirer_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- ── display name ────────────────────────────────────────────────────────────
-- Nullable. This is `offered_by` in the agreement snapshot — who the
-- counterparty understood themselves to be dealing with — so it is hashed into
-- every event, which is the reason a 10,000-character value matters.
alter table contracts drop constraint if exists contracts_display_name_check;
alter table contracts
  add constraint contracts_display_name_check
  check (earner_display_name is null or length(earner_display_name) <= 200);

commit;

-- ROLLBACK
--   alter table contracts drop constraint contracts_project_name_check;
--   alter table contracts drop constraint contracts_dod_shape_check;
--   alter table contracts drop constraint contracts_amount_positive_check;
--   alter table contracts drop constraint contracts_currency_check;
--   alter table contracts drop constraint contracts_invited_email_shape_check;
--   alter table contracts drop constraint contracts_hirer_email_shape_check;
--   alter table contracts drop constraint contracts_display_name_check;
