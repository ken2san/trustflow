#!/usr/bin/env bash
# Fault injection for the create_entry_contract.sh fixture. A fault counts as
# caught only if the runner reached the injection point (its FAULT-INJECTED
# marker), stopped for the expected reason, exited nonzero and never reached
# restore. Any other early failure (Docker, createdb, pg_dump) is not proof.
# Also: a healthy run must restore and pass, and an early setup failure must be
# judged a FAIL by this same check.
set -uo pipefail
cd "$(dirname "$0")/../.."
runner=tests/sql/create_entry_contract.sh
fails=0

# judge FAULT REASON STATUS OUTPUT -> 0 if the fault was genuinely caught.
judge() {
  local fault="$1" reason="$2" status="$3" out="$4"
  [[ $status -ne 0 ]] || { echo "exit 0"; return 1; }
  grep -qx "FAULT-INJECTED: $fault" <<< "$out" || { echo "no FAULT-INJECTED: $fault marker"; return 1; }
  grep -q -- "$reason" <<< "$out" || { echo "expected reason '$reason' not seen"; return 1; }
  ! grep -q 'fixture: restoring' <<< "$out" || { echo "reached restore"; return 1; }
}
expect_caught() {
  local fault="$1" reason="$2" expected_status="$3" out status why
  out="$(TF_FIXTURE_FAULT=$fault bash "$runner" 2>&1)"; status=$?
  if why="$(judge "$fault" "$reason" "$status" "$out")" && [[ $status -eq $expected_status ]]; then
    echo "PASS $fault fault caught at its injection point (exit $status, reason: $reason)"
  else
    echo "FAIL $fault: ${why:-exit $status, expected $expected_status}"; fails=$((fails + 1))
  fi
}

# 1. Injected faults. The TOC fault fails the toc step itself, before any
#    filtering; the event-trigger fault is refused by the allowlist.
expect_caught toc 'FAULT-INJECTED: toc' 1
expect_caught event_trigger 'fixture: event triggers differ from the reviewed set' 1
out="$(TF_FIXTURE_FAULT=toc bash "$runner" 2>&1)"
if grep -q 'event triggers differ' <<< "$out"; then echo "FAIL toc: ran past the failing TOC step into the allowlist"; fails=$((fails + 1)); fi
out="$(TF_FIXTURE_FAULT=event_trigger bash "$runner" 2>&1)"
if ! grep -q '^> unreviewed_hook$' <<< "$out"; then echo "FAIL event_trigger: diff does not name the unreviewed trigger"; fails=$((fails + 1)); fi

# 2. Healthy control: no fault, must restore and pass.
out="$(bash "$runner" 2>&1)"; status=$?
if [[ $status -eq 0 ]] && grep -q 'fixture: restoring' <<< "$out" && grep -qx 'ALL PASSED' <<< "$out" \
   && ! grep -q 'FAULT-INJECTED' <<< "$out"; then
  echo "PASS healthy control restored and passed"
else
  echo "FAIL healthy control (exit $status)"; fails=$((fails + 1))
fi

# 3. An early setup failure, before the injection point, must be judged a FAIL.
out="$(TF_FIXTURE_FAULT=toc TF_FIXTURE_CONTAINER=trustflow-no-such-container bash "$runner" 2>&1)"; status=$?
if why="$(judge toc 'FAULT-INJECTED: toc' "$status" "$out")"; then
  echo "FAIL early setup failure was counted as a caught fault"; fails=$((fails + 1))
else
  echo "PASS early setup failure is not counted as a caught fault (exit $status; $why)"
fi

[[ $fails -eq 0 ]] && echo "harness check: ALL PASSED" || { echo "harness check: $fails failure(s)"; exit 1; }
