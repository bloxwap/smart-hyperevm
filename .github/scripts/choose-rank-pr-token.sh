#!/bin/bash
# Pick the token that will open the rankings pull request.
#
# POST /pulls with a branch that does not exist returns HTTP 422 when the
# token is allowed to create pull requests, and HTTP 403 when it is not.
# 422 creates nothing. The scheduled runs failed after this check would
# have rejected RANK_REGISTRY_TOKEN: GitHub answered
# "Resource not accessible by personal access token" and the response
# header named pull_requests=write.

set -euo pipefail

if [[ -z "${GITHUB_OUTPUT:-}" || -z "${GITHUB_REPOSITORY:-}" || -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_OUTPUT, GITHUB_REPOSITORY, and GITHUB_TOKEN are required." >&2
  exit 1
fi

body_file=$(mktemp)
header_file=$(mktemp)
trap 'rm -f "$body_file" "$header_file"' EXIT

# Prints: status<TAB>message<TAB>accepted-permissions
probe() {
  local token="$1"
  local head_ref="rank-registry-token-probe-${RANDOM}${RANDOM}"
  local status
  status=$(curl -sS \
    -o "$body_file" \
    -D "$header_file" \
    -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls" \
    --data "{\"title\":\"rank-registry token permission probe\",\"head\":\"${head_ref}\",\"base\":\"main\"}")
  status=${status//$'\r'/}
  local message accepted
  message=$(sed -n 's/.*"message"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file")
  message=${message%%$'\n'*}
  accepted=$(grep -i '^x-accepted-github-permissions:' "$header_file" || true)
  accepted=${accepted#*: }
  accepted=${accepted%%$'\n'*}
  accepted=${accepted%$'\r'}
  printf '%s\t%s\t%s\n' "$status" "$message" "$accepted"
}

can_open_pull_request() {
  case "$1" in
    422 | 200 | 201) return 0 ;;
    *) return 1 ;;
  esac
}

report() {
  local label="$1"
  local status="$2"
  local message="$3"
  local accepted="$4"
  echo "${label}: HTTP ${status} ${message}"
  if [[ -n "$accepted" ]]; then
    echo "${label}: GitHub asked for ${accepted}"
  fi
}

use_pat=false
pat_status=""
pat_message=""
pat_accepted=""

if [[ -n "${RANK_REGISTRY_TOKEN:-}" ]]; then
  IFS=$'\t' read -r pat_status pat_message pat_accepted < <(probe "$RANK_REGISTRY_TOKEN")
  report "RANK_REGISTRY_TOKEN" "$pat_status" "$pat_message" "$pat_accepted"
  if can_open_pull_request "$pat_status"; then
    use_pat=true
  fi
else
  echo "RANK_REGISTRY_TOKEN is unset."
fi

if [[ "$use_pat" == "true" ]]; then
  echo "use_pat=true" >>"$GITHUB_OUTPUT"
  echo "Opening the pull request with RANK_REGISTRY_TOKEN."
  exit 0
fi

IFS=$'\t' read -r gha_status gha_message gha_accepted < <(probe "$GITHUB_TOKEN")
report "GITHUB_TOKEN" "$gha_status" "$gha_message" "$gha_accepted"

if can_open_pull_request "$gha_status"; then
  echo "use_pat=false" >>"$GITHUB_OUTPUT"
  echo "::warning::Opening the pull request with GITHUB_TOKEN. pull_request workflows stay waiting until someone selects Approve workflows to run. Give RANK_REGISTRY_TOKEN Pull requests: Read and write (Contents: Read and write is already enough to push) so the next run can open the pull request with that token."
  exit 0
fi

echo "::error::Neither token can open a pull request."
cat <<EOF
RANK_REGISTRY_TOKEN is the token that failed the scheduled runs: it pushed registry/rankings, then POST /pulls returned "Resource not accessible by personal access token". Workflow permissions do not apply to that secret. GITHUB_TOKEN has contents: write and pull-requests: write on this job, and it still cannot open the pull request until an admin allows Actions to create pull requests.

Do one of the following:

1. Allow GITHUB_TOKEN to open pull requests. An organization owner opens https://github.com/organizations/bloxwap/settings/actions → Actions → General → Workflow permissions, enables "Allow GitHub Actions to create and approve pull requests", and saves. New organizations leave this off. If the organization does not lock the setting, the same checkbox is at https://github.com/bloxwap/smart-hyperevm/settings/actions. pull-requests: write in the workflow does not override that checkbox.

2. Let RANK_REGISTRY_TOKEN open the pull request, which also starts CI and security-pr without the approval prompt. Edit the fine-grained personal access token stored as the Actions secret RANK_REGISTRY_TOKEN so its repository access includes bloxwap/smart-hyperevm, Contents is Read and write, and Pull requests is Read and write. If the organization reviews fine-grained tokens, approve the token at https://github.com/organizations/bloxwap/settings/personal-access-tokens. The next run uses the secret once this probe returns HTTP 422.
EOF
exit 1
