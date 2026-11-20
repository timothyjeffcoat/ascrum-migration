# Worker logs

One file per cluster: `spec/worklogs/<cluster>.md`, written only by that cluster's worker sessions
(CLAUDE.md "Logs"). Each session adds a dated entry: what was done, decisions, blockers, questions,
mistakes and wrong turns, and the gate commands actually run, with their summary lines pasted in.

The file also holds the cluster's legacy-test table (spec §9):

| Legacy file | Case | Status (ported / adapted / dead / n/a) | New test | Note |
|---|---|---|---|---|
