#!/usr/bin/env bash
# Appends machine-recorded workflow events to spec/metrics.jsonl (one JSON object per line).
# Wired up in .claude/settings.json. Reads the hook payload as JSON on stdin.
#
# Every worktree writes to the MAIN checkout's spec/metrics.jsonl (resolved via
# git's common dir), so parallel workers share one log and never merge-conflict on it.
# It must never break a session: all failures are swallowed.

set -u
payload="$(cat)"

event="$(jq -r '.hook_event_name // empty' <<<"$payload" 2>/dev/null)"
[ -z "$event" ] && exit 0

cwd="$(jq -r '.cwd // empty' <<<"$payload")"
cwd="${cwd:-$PWD}"

common_dir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
main_root="$(dirname "$common_dir")"
log="$main_root/spec/metrics.jsonl"
mkdir -p "$main_root/spec"

branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
commit="$(git -C "$cwd" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Record a label, never an absolute path: the log is committed to a public repo.
toplevel="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")"
if [ "$toplevel" = "$main_root" ]; then worktree="main"; else worktree="$(basename "$toplevel")"; fi

# Classify a shell command into a gate category; empty = not a gate (not logged).
classify() {
  local c="$1" pm='(^|[;&|[:space:]])(npm|pnpm|yarn|bun|npx|pnpx|pnpm[[:space:]]+exec)[[:space:]]+(run[[:space:]]+)?'
  # Order matters: git/gh first so commit messages like "fix build" aren't counted as builds.
  if   grep -qE '(^|[;&|[:space:]])git[[:space:]]+commit' <<<"$c";                    then echo commit
  elif grep -qE '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+(create|merge)' <<<"$c"; then echo pr
  elif grep -qE '(^|[;&|[:space:]])gh[[:space:]]+run' <<<"$c";                          then echo ci
  elif grep -qE "${pm}verify" <<<"$c";                                                   then echo verify
  elif grep -qE "playwright|${pm}(test:)?e2e" <<<"$c";                                  then echo e2e
  elif grep -qE "(^|[;&|[:space:]/])(vitest|jest|karma)([[:space:]]|$)|${pm}test" <<<"$c"; then echo test
  elif grep -qE "(^|[;&|[:space:]/])(eslint|jshint)([[:space:]]|$)|prettier.*--check|${pm}lint" <<<"$c"; then echo lint
  elif grep -qE "(^|[;&|[:space:]/])tsc([[:space:]]|$)|${pm}typecheck" <<<"$c";          then echo typecheck
  elif grep -qE "vite[[:space:]]+build|(^|[;&|[:space:]])grunt([[:space:]]|$)|${pm}build" <<<"$c"; then echo build
  else echo ""
  fi
}

record=""
case "$event" in
  SessionStart)
    record="$(jq -c '{source: (.source // null)}' <<<"$payload")" ;;
  SessionEnd)
    record="$(jq -c '{reason: (.reason // null)}' <<<"$payload")" ;;
  PostToolUse|PostToolUseFailure)
    tool="$(jq -r '.tool_name // empty' <<<"$payload")"
    if [ "$tool" = "Bash" ]; then
      cmd="$(jq -r '.tool_input.command // empty' <<<"$payload")"
      # Classify only the command itself, not heredoc bodies (docs written via `cat <<EOF` mention tool names).
      cat_="$(classify "${cmd%%<<*}")"
      [ -z "$cat_" ] && exit 0
      status=pass; [ "$event" = "PostToolUseFailure" ] && status=fail
      record="$(jq -c --arg cat "$cat_" --arg status "$status" \
        '{tool:"Bash", category:$cat, status:$status, command:.tool_input.command,
          error:(if .error then (.error|tostring) else null end)}' <<<"$payload")"
    elif [ "$tool" = "Agent" ]; then
      status=pass; [ "$event" = "PostToolUseFailure" ] && status=fail
      record="$(jq -c --arg status "$status" \
        '{tool:"Agent", category:"subagent", status:$status,
          subagent_type:(.tool_input.subagent_type // "general-purpose"),
          description:(.tool_input.description // null)}' <<<"$payload")"
    else
      exit 0
    fi ;;
  *) exit 0 ;;
esac

# The log is public: replace the home directory with "~" in every string field (commands, errors), and
# Claude Code's temp dir, whose name encodes the home path (/tmp/claude-<uid>/-home-<user>-...), with "<claude-tmp>".
# Redact before truncating (R2-14): a path cut at character 300 no longer matches $HOME.
# Masks: the home dir; any other /home/<name>; Claude's temp dir; and "-home-<user>-..." segments,
# which is how Claude Code encodes a project path in folder names (~/.claude/projects/-home-...).
# Then the bare login name and git e-mail, wherever they still appear (e.g. a grep pattern in a command):
# the path rules alone let a username through (2026-11-23, ledger row 317). split/join is a literal
# replace, so no regex escaping; names under 3 characters are skipped so they can't mangle ordinary text.
user="$(id -un 2>/dev/null || true)"
email="$(git -C "$cwd" config user.email 2>/dev/null || true)"
record="$(jq -c --arg home "$HOME" --arg user "$user" --arg email "$email" '
  walk(if type == "string" then
         (if $home != "" then gsub($home; "~") else . end)
         | gsub("/tmp/claude-[0-9]+/[^/\\s\"]*"; "<claude-tmp>")
         | gsub("/home/[^/\\s\"]+"; "/home/<user>")
         | gsub("-home-[^/\\s\"]*"; "<project-dir>")
         | (if ($email | length) >= 3 then split($email) | join("<email>") else . end)
         | (if ($user | length) >= 3 then split($user) | join("<user>") else . end)
       else . end)
  | if .command then .command |= .[0:300] else . end
  | if .error then .error |= .[0:300] else . end' <<<"$record")" || exit 0

line="$(jq -c \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg event "$event" \
  --arg branch "$branch" --arg commit "$commit" --arg worktree "$worktree" \
  --arg session "$(jq -r '.session_id // empty' <<<"$payload")" \
  '{ts:$ts, event:$event, session:$session, branch:$branch, commit:$commit, worktree:$worktree} + .' \
  <<<"$record")" || exit 0

( flock -w 5 9 && printf '%s\n' "$line" >>"$log" ) 9>>"$log.lock"
exit 0
