#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
for dependency in bun sf jq; do command -v "$dependency" >/dev/null || { echo "Missing $dependency" >&2; exit 1; }; done
if [[ -f "$project_dir/.dev.vars" ]]; then
  exec bun --env-file="$project_dir/.dev.vars" "$project_dir/scripts/data-cloud/verify.ts" "$@"
fi
exec bun "$project_dir/scripts/data-cloud/verify.ts" "$@"
