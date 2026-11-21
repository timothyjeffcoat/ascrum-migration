# Phase 2 and 3 questions

One file per cluster, `spec/questions/<cluster>.md`, so parallel worktrees never edit the same file
(spec §8.5). Ids are `Q-<cluster>-<n>`. Each question gives context, options, and a recommendation.
The orchestrator relays it to the owner and commits the answer through a small PR.

`harness.md` holds the questions the orchestrator raised while building Phase 2.
