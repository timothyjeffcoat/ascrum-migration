#!/usr/bin/env bash
# The OS-package and dependency scan of the built images (spec §6 image-scan; owner's answer to
# Q-p5-image-cves-2 (a)): Trivy, on both images, fails on any HIGH or CRITICAL finding, fixed or not.
#
#   docker/scan-images.sh <api image> <web image>        (from the repo root; the images must be local)
#
# Needs docker, jq and Trivy: $TRIVY, or `trivy` on the PATH, at the version pinned in
# .github/actions/setup-trivy. A missing tool fails the scan; it is never skipped.
#
# ECR's scan-on-push gate (infra/scripts/imageScan.ts) stays the final check on the image that is
# deployed. This scan runs on the PR, one AWS run earlier, and also covers the web image, which ECR never
# sees. The two use different data and can disagree in either direction (spec/worklogs/p5-image-scan.md).
#
# Fails closed. Every one of these fails the scan, never passes it:
#   - the vulnerability DB cannot be downloaded (it is fetched on every run, into an empty cache, so there
#     is no older copy to fall back on), or the downloaded DB is more than 3 days old;
#   - Trivy exits non-zero on either image (an image it cannot read, a crash, a timeout);
#   - the report does not show an Alpine OS with every package apk lists in the image;
#   - any HIGH or CRITICAL finding.
# No ignore list without an owner answer: every TRIVY_* variable is dropped, Trivy runs in an empty folder
# with --config '' and --ignorefile '' (so no trivy.yaml or .trivyignore is read), and no VEX source,
# ignore policy, --ignore-unfixed or --ignore-status is passed.
#
# Writes each image's JSON report to $SCAN_REPORT_DIR (default: a temporary folder) for CI to upload.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <api image> <web image>" >&2
  exit 2
fi
trivy=${TRIVY:-trivy}
command -v "$trivy" > /dev/null || {
  echo "scan-images: Trivy not found (set TRIVY or put trivy on the PATH)" >&2
  exit 2
}
trivy=$(command -v "$trivy")
for tool in docker jq; do
  command -v "$tool" > /dev/null || {
    echo "scan-images: $tool not found" >&2
    exit 2
  }
done
while read -r name; do unset "$name"; done < <(compgen -e | grep '^TRIVY_' || true)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
reports=${SCAN_REPORT_DIR:-$work/reports}
mkdir -p "$reports"
reports=$(cd "$reports" && pwd)
mkdir "$work/empty"
cd "$work/empty"
findings=0
fail() {
  echo "scan-images FAIL: $*" >&2
  findings=$((findings + 1))
}

# --- The vulnerability DB: downloaded now, into an empty cache ---------------------------------------
started=$(date -u +%s)
cache="$work/cache"
if ! "$trivy" image --cache-dir "$cache" --config '' --no-progress --disable-telemetry --skip-version-check \
  --download-db-only; then
  echo "scan-images FAIL: could not download Trivy's vulnerability DB (the scan never passes without it)" >&2
  exit 1
fi
db=$("$trivy" version --cache-dir "$cache" --config '' --format json)
updated=$(jq -r '.VulnerabilityDB.UpdatedAt // empty' <<< "$db")
downloaded=$(jq -r '.VulnerabilityDB.DownloadedAt // empty' <<< "$db")
if [[ -z $updated || -z $downloaded ]]; then
  echo "scan-images FAIL: no vulnerability DB in the cache after the download: $db" >&2
  exit 1
fi
updated_s=$(date -u -d "$updated" +%s)
downloaded_s=$(date -u -d "$downloaded" +%s)
if ((downloaded_s < started - 5)); then
  echo "scan-images FAIL: the DB in the cache was not downloaded by this run (DownloadedAt $downloaded)" >&2
  exit 1
fi
if ((started - updated_s > 3 * 24 * 3600)); then
  echo "scan-images FAIL: the downloaded DB was built at $updated, more than 3 days ago" >&2
  exit 1
fi
echo "Trivy $(jq -r .Version <<< "$db"), vulnerability DB built $updated, downloaded $downloaded"

# --- Each image ------------------------------------------------------------------------------------
scan() {
  local image=$1 label=$2 report="$reports/$2.json" os pkgs apk_pkgs count
  if ! "$trivy" image --cache-dir "$cache" --config '' --ignorefile '' --no-progress --disable-telemetry \
    --skip-version-check --skip-db-update --image-src docker --scanners vuln --pkg-types os,library \
    --severity HIGH,CRITICAL --list-all-pkgs --format json --output "$report" --exit-code 0 "$image"; then
    fail "$image: Trivy could not scan it (its log is above)"
    return
  fi
  os=$(jq -r '.Metadata.OS | "\(.Family // "") \(.Name // "")"' "$report")
  [[ $os == alpine\ * ]] || fail "$image: Trivy did not detect Alpine (OS: '$os'), so its OS packages were not scanned"
  pkgs=$(jq '[.Results[]? | select(.Class == "os-pkgs") | .Packages[]?] | length' "$report")
  if ! apk_pkgs=$(docker run --rm --network none --entrypoint sh "$image" -c "grep -c '^P:' /lib/apk/db/installed"); then
    fail "$image: could not count the packages in /lib/apk/db/installed"
  elif [[ $pkgs != "$apk_pkgs" ]]; then
    fail "$image: Trivy read $pkgs OS packages, apk lists $apk_pkgs"
  fi
  count=$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$report")
  if ((count > 0)); then
    fail "$image: $count HIGH or CRITICAL finding(s):"
    jq -r '.Results[]? | .Target as $t | .Vulnerabilities[]? |
      "  \(.Severity)\t\(.VulnerabilityID)\t\(.PkgName) \(.InstalledVersion) (fixed: \(.FixedVersion // "none"))\t\($t)"' \
      "$report" | sort >&2
  else
    echo "$image: $os, $pkgs OS packages (as apk lists them) and $(jq '[.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length' "$report") language packages scanned; no HIGH or CRITICAL finding"
  fi
}
scan "$1" api
scan "$2" web

if ((findings > 0)); then
  echo "scan-images: $findings finding(s); JSON reports in $reports" >&2
  exit 1
fi
echo "scan-images: no HIGH or CRITICAL finding in either image (Trivy; ECR's gate stays the final check on the deployed image)"
