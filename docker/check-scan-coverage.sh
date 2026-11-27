#!/usr/bin/env bash
# The image scan's coverage, checked against the images as read on the host (p5-image-host;
# DEV-p5-image-scan-04 (b) and -15). docker/scan-images.sh fails on Trivy's findings, but a scan that read
# too little finds nothing: before this, coverage was compared for OS packages only, and only as a count
# taken by the image's own `grep`; the API image's Node packages were printed and compared with nothing,
# so a lockfile or package.json Trivy silently stopped reading would pass. Here, for each image and each
# of the scan's JSON reports:
#   - OS packages: the set Trivy read (name and version) must equal the set in apk's installed database,
#     read from the image's layers on the host by docker/image-fs.ts;
#   - language packages: in the HIGH/CRITICAL pass (`--pkg-types os,library`), the set Trivy read
#     (name@version and file) must equal every package.json with a name and a version in the image's final
#     filesystem, also read on the host; the fixed-OS pass (`--pkg-types os`) must read none.
# The nginx window is decided in one place only, docker/scan-images.sh, which also reads its facts on the
# host (owner's answer to Q-p5-image-host-1 (b)).
#
#   docker/check-scan-coverage.sh <api image> <web image> <report dir>   (from the repo root, after
#                                                                         docker/scan-images.sh)
#
# Needs docker, jq, GNU tar and Node 24. Fails closed: a missing or unreadable report, an image that cannot
# be read, or any difference fails; nothing is skipped.
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <api image> <web image> <report dir>" >&2
  exit 2
fi
api_image=$1
web_image=$2
reports=$3
for tool in docker jq tar node; do
  command -v "$tool" > /dev/null || {
    echo "check-scan-coverage: $tool not found" >&2
    exit 2
  }
done
node_major=$(node -p 'process.versions.node.split(".")[0]')
if ((node_major < 24)); then
  echo "check-scan-coverage: docker/image-fs.ts needs Node 24 or later; node is $(node --version)" >&2
  exit 2
fi
image_fs() { node docker/image-fs.ts "$@"; }
findings=0
fail() {
  echo "check-scan-coverage FAIL: $*" >&2
  findings=$((findings + 1))
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

model_of() {
  local image=$1 out=$2 dir ids
  dir=$(mktemp -d "$work/save.XXXXXX")
  ids=$(docker image inspect --format '{{range $i, $l := .RootFS.Layers}}{{if $i}},{{end}}{{$l}}{{end}}' "$image")
  if ! docker save "$image" | tar -x --no-same-owner --no-same-permissions -C "$dir" -f - ||
    ! image_fs read "$dir" "$ids" "$out" > /dev/null; then
    echo "check-scan-coverage FAIL: $image: could not read the image's layers on the host (above)" >&2
    exit 1
  fi
  rm -rf "$dir"
}

# What the report says Trivy read: OS packages as name<TAB>version, language packages as
# name@version<TAB>/file, each sorted. A report jq cannot read fails.
trivy_os() { jq -r '[.Results[]? | select(.Class == "os-pkgs") | .Packages[]? | "\(.Name)\t\(.Version)"] | .[]' "$1" | LC_ALL=C sort; }
trivy_lang() {
  jq -r '[.Results[]? | select(.Class == "lang-pkgs") | .Target as $t | .Packages[]?
    | "\(.Name)@\(.Version)\t/\((.FilePath // $t) | ltrimstr("/"))"] | .[]' "$1" | LC_ALL=C sort
}

check_image() {
  local image=$1 label=$2 model="$work/$2.json" host_os host_lang report pass os lang before=$findings
  model_of "$image" "$model"
  host_os=$(image_fs apk-installed "$model" | LC_ALL=C sort)
  host_lang=$(image_fs node-packages "$model" | LC_ALL=C sort)
  [[ -n $host_os ]] || fail "$image: no OS packages in apk's installed database, so there is nothing to compare"
  for pass in "$label" "$label-os-fixed"; do
    report="$reports/$pass.json"
    if [[ ! -f $report ]]; then
      fail "$image: no report $report (run docker/scan-images.sh with SCAN_REPORT_DIR first)"
      continue
    fi
    if ! os=$(trivy_os "$report") || ! lang=$(trivy_lang "$report"); then
      fail "$image: $report is not a Trivy JSON report jq can read"
      continue
    fi
    if [[ $os != "$host_os" ]]; then
      fail "$image ($pass): Trivy's OS packages differ from apk's installed database: $(diff <(echo "$host_os") <(echo "$os") | grep '^[<>]' | tr '\t\n' ' ;')(< image, > Trivy)"
    fi
    local want_lang=$host_lang
    [[ $pass == "$label" ]] || want_lang=''
    if [[ $lang != "$want_lang" ]]; then
      fail "$image ($pass): Trivy's language packages differ from the image's package.json files: $(diff <(echo "$want_lang") <(echo "$lang") | grep '^[<>]' | tr '\t\n' ' ;')(< image, > Trivy)"
    fi
  done
  if ((findings == before)); then
    echo "$image: Trivy read exactly the $(wc -l <<< "$host_os") OS packages in apk's database and the $(grep -c . <<< "$host_lang" || true) package.json packages in the image, in both passes as each pass scans them"
  fi
}
check_image "$api_image" api
check_image "$web_image" web

if ((findings > 0)); then
  echo "check-scan-coverage: $findings finding(s)" >&2
  exit 1
fi
echo "check-scan-coverage: the scan read every OS and language package in both images (DEV-p5-image-scan-04 (b)), checked on the host"
