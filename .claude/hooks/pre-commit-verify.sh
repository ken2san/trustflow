#!/usr/bin/env bash
# pre-commit-verify.sh — PreToolUse hook, scoped to `git commit *` via the
# "if" filter in .claude/settings.json. Blocks the commit if the project's
# actual test command (detected from its manifest, not pinned) fails —
# turns AGENTS.md's "Never commit unverified code" into a mechanical gate
# instead of relying on the agent to remember to run tests first.
set -uo pipefail

# Scope ourselves, rather than trusting the "if": "Bash(git commit *)" filter
# in .claude/settings.json. On 2026-11-05 this hook fired on a Bash call that
# contained no git command at all, so that filter is not doing what it says
# here. It went unnoticed for as long as the hook only ran the unit tests,
# which always passed — a config that silently does not do what it claims,
# which is the same class of failure as everything else found today.
#
# The hook receives the tool call as JSON on stdin. If we can read it and it is
# not a git commit, do nothing. If we cannot read it at all, fall through and
# verify: a needless verification costs time, a skipped one costs a bad commit.
if command -v jq &>/dev/null; then
  PAYLOAD="$(cat 2>/dev/null || true)"
  if [[ -n "$PAYLOAD" ]]; then
    CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
    if [[ -n "$CMD" && "$CMD" != *"git commit"* ]]; then
      exit 0
    fi
  fi
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 0

# Detect the test command the same way global.instructions.md's
# Verification Commands section tells the agent to: from the stack's own
# manifest, never pinned. No manifest match means nothing to verify
# against, so allow the commit through rather than blocking on a guess.
TEST_CMD=""
if [[ -f package.json ]] && command -v jq &>/dev/null; then
  script="$(jq -r '.scripts.test // empty' package.json 2>/dev/null)"
  [[ -n "$script" && "$script" != *"no test specified"* ]] && TEST_CMD="npm test"
elif [[ -f Makefile ]] && grep -q '^test:' Makefile 2>/dev/null; then
  TEST_CMD="make test"
elif [[ -f pyproject.toml ]] && command -v pytest &>/dev/null; then
  TEST_CMD="pytest"
elif [[ -f Cargo.toml ]] && command -v cargo &>/dev/null; then
  TEST_CMD="cargo test"
fi

# Lint and build run before the tests, because they are the two gates the test
# suite demonstrably cannot stand in for. Added 2026-11-05 after the same
# failure happened three times in one session: an import or a state hook was
# removed while a call to it stayed behind. Vite builds fine — esbuild does not
# resolve identifiers — and the unit suite renders no component, so the first
# notice was 33 E2E failures against a blank screen. One of the three left the
# live mode switch throwing inside a setTimeout, which stranded a loading
# overlay on screen for ever while the E2E test for that very button passed.
# ESLint's no-undef caught the second and third at edit time.
#
# Each gate is skipped rather than failed when the project does not define it,
# so this stays correct in a repo with no lint script.
run_gate() {
  local label="$1"; shift
  if ! OUTPUT="$("$@" 2>&1)"; then
    echo "Blocked commit: $label failed. Fix it before committing." >&2
    echo "" >&2
    echo "$OUTPUT" | tail -n 60 >&2
    exit 2
  fi
}

if [[ -f package.json ]] && command -v jq &>/dev/null; then
  [[ -n "$(jq -r '.scripts.lint // empty' package.json)" ]] && run_gate "npm run lint" npm run lint
  [[ -n "$(jq -r '.scripts.build // empty' package.json)" ]] && run_gate "npm run build" npm run build
fi

[[ -z "$TEST_CMD" ]] && exit 0
run_gate "$TEST_CMD" bash -c "$TEST_CMD"

exit 0
