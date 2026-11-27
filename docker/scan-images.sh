#!/usr/bin/env bash
# The OS-package and dependency scan of the built images (spec §6 image-scan; owner's answers to
# Q-p5-image-cves-2 (a), Q-p5-image-scan-2 (a)+(c) and Q-p5-image-scan-3 (a)). Trivy, two passes per image:
#   1. OS and language packages, HIGH and CRITICAL, fixed or not;
#   2. OS packages, every severity, only findings that have a fix (`--ignore-unfixed`): an Alpine package
#      left below a version Alpine has fixed fails whatever anyone's severity says (Trivy rates
#      CVE-2026-4738 MEDIUM, ECR rated it CRITICAL: DEV-p5-image-cves-02 / D03).
# Any finding of either pass fails the scan, except inside the nginx window below.
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
# The nginx window (owner's answer to Q-p5-image-scan-2 (c)). The web image's nginx package comes from
# nginx.org through the pinned nginx-unprivileged base, and its fixes (1.30.7) are in no such image yet. So,
# for the web image only, findings in the package named exactly `nginx` are reported but do not fail, while
# the window is open. It closes by itself, with no edit to this file:
#   - when the web image's installed nginx is at or above WINDOW_CLOSES_AT_NGINX (apk's own comparison, in
#     the image; anything but a clean `<` closes it), or
#   - after WINDOW_EXPIRES (UTC), whatever nginx is installed.
# Once closed, nginx findings fail like any other. Every other package in the web image, and everything in
# the API image, is gated in full all the time. Each run prints the window's state, the nginx CVEs it
# reported and both exit conditions. This is not an ignore list: nothing is hidden, and nothing outside
# that one package in that one image is affected.
#
# Fails closed. Every one of these fails the scan, never passes it:
#   - the vulnerability DB cannot be downloaded (it is fetched on every run, into an empty cache, so there
#     is no older copy to fall back on), or the downloaded DB is more than 3 days old;
#   - Trivy exits non-zero on either image (an image it cannot read, a crash, a timeout);
#   - a report does not show an Alpine OS with every package apk lists in the image;
#   - any finding of either pass outside the open nginx window.
# No ignore list without an owner answer: every TRIVY_* variable is dropped, Trivy runs in an empty folder
# with --config '' and --ignorefile '' (so no trivy.yaml or .trivyignore is read), and no VEX source,
# ignore policy or --ignore-status is passed (pass 1 has no --ignore-unfixed either).
#
# Writes each image's JSON reports to $SCAN_REPORT_DIR (default: a temporary folder) for CI to upload.
set -euo pipefail

WINDOW_PACKAGE=nginx
WINDOW_CLOSES_AT_NGINX=1.30.7-r0
WINDOW_EXPIRES=2026-12-31
DB_MAX_AGE_SECONDS=$((3 * 24 * 3600))

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
# Exactly the release .github/actions/setup-trivy pins (DEV-p5-image-scan-04 (a)): move both together.
PINNED_TRIVY_VERSION=0.76.2
trivy_version=$("$trivy" --version 2>&1 | sed -n 's/^Version: //p' | head -1)
if [[ $trivy_version != "$PINNED_TRIVY_VERSION" ]]; then
  echo "scan-images: $trivy is Trivy '${trivy_version:-unknown}', not the pinned $PINNED_TRIVY_VERSION" >&2
  exit 2
fi

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
if ((started - updated_s > DB_MAX_AGE_SECONDS)); then
  echo "scan-images FAIL: the downloaded DB was built at $updated, more than $((DB_MAX_AGE_SECONDS / 3600)) hours ago" >&2
  exit 1
fi
echo "Trivy $(jq -r .Version <<< "$db"), vulnerability DB built $updated, downloaded $downloaded"

# --- The nginx window: open or closed, decided from the web image and the date ----------------------
window_open=no
window_reason=''
window_state() {
  local image=$1 today have op
  today=$(date -u +%F)
  if [[ $today > $WINDOW_EXPIRES ]]; then
    window_reason="expired: today ($today) is after $WINDOW_EXPIRES"
    return
  fi
  if ! have=$(docker run --pull never --rm --network none --entrypoint sh "$image" -c \
    'awk -v p="P:$1" '\''$0 == p { found = 1 } found && /^V:/ { print substr($0, 3); exit }'\'' /lib/apk/db/installed' \
    sh "$WINDOW_PACKAGE" 2>&1); then
    window_reason="closed: could not read the installed $WINDOW_PACKAGE version ($have)"
    return
  fi
  if [[ -z $have ]]; then
    window_reason="closed: $WINDOW_PACKAGE is not installed in $image"
    return
  fi
  op=$(docker run --pull never --rm --network none --entrypoint apk "$image" version -t "$have" "$WINDOW_CLOSES_AT_NGINX" 2>&1 || true)
  if [[ $op == '<' ]]; then
    window_open=yes
    window_reason="open: installed $WINDOW_PACKAGE $have is below $WINDOW_CLOSES_AT_NGINX, and today ($today) is not after $WINDOW_EXPIRES"
  else
    window_reason="closed: installed $WINDOW_PACKAGE $have compared with $WINDOW_CLOSES_AT_NGINX gives '$op' (only '<' keeps it open)"
  fi
}

# --- Each image, two passes --------------------------------------------------------------------------
windowed=() # "<pass>\t<severity>\t<CVE>\t<package> <version> (fixed: …)" lines reported inside the window
check_report() {
  local image=$1 label=$2 pass=$3 report=$4 os pkgs apk_pkgs=$5 in_window=$6 all blocking
  os=$(jq -r '.Metadata.OS | "\(.Family // "") \(.Name // "")"' "$report")
  [[ $os == alpine\ * ]] || fail "$image ($pass): Trivy did not detect Alpine (OS: '$os'), so its OS packages were not scanned"
  pkgs=$(jq '[.Results[]? | select(.Class == "os-pkgs") | .Packages[]?] | length' "$report")
  [[ $pkgs == "$apk_pkgs" ]] || fail "$image ($pass): Trivy read $pkgs OS packages, apk lists $apk_pkgs"
  # Every finding, then the ones the window may hold: Class os-pkgs and PkgName exactly $WINDOW_PACKAGE.
  all=$(jq -r '.Results[]? | .Class as $c | .Target as $t | .Vulnerabilities[]? |
    [$c, .PkgName, .Severity, .VulnerabilityID, "\(.PkgName) \(.InstalledVersion) (fixed: \(.FixedVersion // "none"))", $t] | @tsv' "$report")
  if [[ $in_window == yes ]]; then
    blocking=$(awk -F'\t' -v p="$WINDOW_PACKAGE" '!($1 == "os-pkgs" && $2 == p)' <<< "$all")
    while IFS=$'\t' read -r _ _ sev id what _; do
      [[ -n $id ]] && windowed+=("$pass	$sev	$id	$what")
    done < <(awk -F'\t' -v p="$WINDOW_PACKAGE" '$1 == "os-pkgs" && $2 == p' <<< "$all")
  else
    blocking=$all
  fi
  blocking=$(sed '/^$/d' <<< "$blocking")
  if [[ -n $blocking ]]; then
    fail "$image ($pass): $(wc -l <<< "$blocking") finding(s) that fail the scan:"
    awk -F'\t' '{ printf "  %s\t%s\t%s\t%s\n", $3, $4, $5, $6 }' <<< "$blocking" | sort >&2
  fi
  echo "$image ($pass): $os, $pkgs OS packages (as apk lists them), $(jq '[.Results[]? | select(.Class == "lang-pkgs") | .Packages[]?] | length' "$report") language packages; $(sed '/^$/d' <<< "$all" | wc -l) finding(s), $( [[ -n $blocking ]] && wc -l <<< "$blocking" || echo 0) failing"
}
scan() {
  local image=$1 label=$2 apk_pkgs in_window=no
  if ! apk_pkgs=$(docker run --pull never --rm --network none --entrypoint sh "$image" -c "grep -c '^P:' /lib/apk/db/installed"); then
    fail "$image: could not count the packages in /lib/apk/db/installed"
    return
  fi
  if [[ $label == web ]]; then
    window_state "$image"
    in_window=$window_open
  fi
  local common=(--cache-dir "$cache" --config '' --ignorefile '' --no-progress --disable-telemetry
    --skip-version-check --skip-db-update --image-src docker --scanners vuln --list-all-pkgs --format json
    --exit-code 0)
  if ! "$trivy" image "${common[@]}" --pkg-types os,library --severity HIGH,CRITICAL \
    --output "$reports/$label.json" "$image"; then
    fail "$image (HIGH/CRITICAL pass): Trivy could not scan it (its log is above)"
  else
    check_report "$image" "$label" 'HIGH/CRITICAL pass' "$reports/$label.json" "$apk_pkgs" "$in_window"
  fi
  if ! "$trivy" image "${common[@]}" --pkg-types os --ignore-unfixed \
    --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --output "$reports/$label-os-fixed.json" "$image"; then
    fail "$image (fixed OS pass): Trivy could not scan it (its log is above)"
  else
    check_report "$image" "$label" 'fixed OS pass' "$reports/$label-os-fixed.json" "$apk_pkgs" "$in_window"
  fi
}
scan "$1" api
scan "$2" web

# --- The window's notice, every run ------------------------------------------------------------------
{
  echo "=============================================================================================="
  echo "NGINX WINDOW (owner's answer to Q-p5-image-scan-2 (c)), web image only, package '$WINDOW_PACKAGE' only:"
  echo "  state: ${window_reason:-not evaluated (the web image could not be read)}"
  echo "  closes when the web image's installed nginx >= $WINDOW_CLOSES_AT_NGINX, or after $WINDOW_EXPIRES (UTC)."
  echo "  Every other finding, in either image, fails the scan now."
  if ((${#windowed[@]} > 0)); then
    echo "  Reported inside the window (NOT failing, NOT fixed):"
    printf '    %s\n' "${windowed[@]}" | sort
  else
    echo "  Nothing reported inside the window."
  fi
  echo "=============================================================================================="
} >&2
# A workflow command's data, escaped as the Actions toolkit's escapeData does (`%` first, then CR and LF),
# after dropping everything but printable ASCII, CR and LF: window_reason can carry docker or apk output
# (DEV-p5-image-scan-07 note A), which must not end the command or start another.
gha_data() {
  local s
  s=$(printf '%s' "$1" | LC_ALL=C tr -cd '\r\n -~')
  s=${s//'%'/%25}
  s=${s//$'\r'/%0D}
  s=${s//$'\n'/%0A}
  printf '%s' "$s"
}
if [[ -n ${GITHUB_ACTIONS:-} ]]; then
  echo "::warning title=nginx window (Q-p5-image-scan-2)::$(gha_data "${#windowed[@]} nginx finding(s) in the web image reported, not failed; ${window_reason:-not evaluated}. Closes at nginx >= $WINDOW_CLOSES_AT_NGINX or after $WINDOW_EXPIRES.")"
fi

if ((findings > 0)); then
  echo "scan-images: $findings failure(s); JSON reports in $reports" >&2
  exit 1
fi
echo "scan-images: no failing finding in either image (Trivy, two passes; ECR's gate stays the final check on the deployed image)"
