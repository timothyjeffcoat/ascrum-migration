# Sourced by docker/check-images.sh, docker/scan-images.sh and docker/check-scan-coverage.sh: the one way
# they print text that came from an image (a path, a package name or version, a USER, an app's log line) or
# from Trivy's reading of one (DEV-p5-image-host-05, -13 / sec-09). Such text must not start a new log line or
# be read by the Actions runner as a workflow command:
#   - every control character (C0 and DEL) becomes `?`; in log_safe a newline does too, so the text stays on
#     the caller's line, and log_safe_lines keeps newlines but treats each line the same way;
#   - every `##[` becomes `##(`: the runner takes `##[` anywhere in a line as its old command form
#     (actions/runner ActionCommand.cs, the fallback when the `::` form does not parse), for example
#     `##[warning]` or `##[add-mask]`;
#   - every `::` in a line becomes `:?:` (a run of colons becomes `:?:?:…`, so no `::` is left), which takes
#     away the runner's current command form. Its v2 parser trims the line with .NET TrimStart(), which
#     drops every Unicode blank (U+00A0, U+2003, U+3000, …), and then checks StartsWith("::"); escaping a
#     `::` only after ASCII blanks let `<U+00A0>::warning::x` through (DEV-p5-image-host-14 / sec-10). Text
#     with a legitimate `::` (an IPv6 address, a C++ name) prints as `:?:`; nothing here is parsed back.
# The second `::` pass catches the pairs a run of three or more colons leaves after the first.
# docker/image-fs.ts escapes what it prints the same way. Usage: log_safe "<text>", or <cmd> | log_safe_lines.
log_safe_lines() {
  LC_ALL=C tr '\000-\010\013-\037\177' '?' | LC_ALL=C sed -e 's/##\[/##(/g' -e 's/::/:?:/g' -e 's/::/:?:/g'
}
log_safe() {
  printf '%s' "$*" | LC_ALL=C tr '\n' '?' | log_safe_lines
}
