#!/usr/bin/env bash
# Spend guard for the live e2e job (paid Gemini calls): decide whether this
# PR's diff can possibly affect AI behavior.
#
# Emits `skip=true` to $GITHUB_OUTPUT ONLY when EVERY changed file matches a
# safe-path allowlist (docs, admin-only UI, operator scripts, app-UI i18n
# catalogs, non-e2e tests, repo meta). One file outside the allowlist — or
# any error reading the file list — emits `skip=false` and the full suite
# runs: a list mistake can only waste a run, never lose coverage.
#
# This is an in-job decision rather than a workflow `paths` filter on
# purpose: the check must still report SUCCESS when it opts out, because the
# merge policy treats a skipped/pending check as blocking.
#
# Usage: e2e-safe-paths.sh <owner/repo> <pr-number>   (needs GH_TOKEN)

set -euo pipefail

REPO="$1"
PR="$2"

emit() {
  echo "skip=$1" >> "$GITHUB_OUTPUT"
  echo "$2"
  exit 0
}

files=$(gh api "repos/$REPO/pulls/$PR/files" --paginate -q '.[].filename') ||
  emit false "Could not list PR files — running the full live suite (fail-open)."

if [ -z "$files" ]; then
  emit false "Empty file list — running the full live suite (fail-open)."
fi

while IFS= read -r f; do
  case "$f" in
    # --- NOT safe: overrides that must beat the broader safe globs below ---
    tests/e2e/*) emit false "AI-relevant change: $f — running the full live suite." ;;
    .github/workflows/ci.yml | .github/scripts/e2e-gate.sh | .github/scripts/e2e-safe-paths.sh)
      emit false "e2e job definition changed: $f — running the full live suite." ;;
    messages/edge-en.json | messages/edge-es.json)
      emit false "Edge (voice IVR/SMS) strings changed: $f — running the full live suite." ;;

    # --- Safe: provably cannot change what the live suite exercises ---
    docs/* | PRDs/* | *.md) ;;                                     # documentation
    src/app/admin/* | src/components/admin/* | src/lib/admin/*) ;; # admin-only operator views
    src/app/about/* | src/app/compare/* | src/app/contact/* | src/app/faq/* | \
    src/app/features/* | src/app/industries/* | src/app/pricing/* | \
    src/app/privacy/* | src/app/terms/*) ;;                        # marketing/legal pages
    messages/en.json | messages/es.json) ;;                        # app-UI catalogs (edge-* is unsafe above)
    debug/* | scripts/*) ;;                                        # operator one-shots, not in the app bundle
    tests/*) ;;                                                    # unit tests (tests/e2e/* is unsafe above)
    .cursor/* | .github/*) ;;                                      # repo meta (own workflow is unsafe above)

    # --- Anything else: run the suite ---
    *) emit false "AI-relevant change: $f — running the full live suite." ;;
  esac
done <<< "$files"

emit true "Every changed file is on the safe-path allowlist — skipping the paid live suite."
