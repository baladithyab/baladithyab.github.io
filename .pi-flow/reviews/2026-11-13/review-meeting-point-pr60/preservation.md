# Work preservation and squash policy

The user requested keeping the work and squash-merging PR #60 after review.

- Keep all four committed `docs/benchmarks/meeting-point-*.json.gz` evidence archives. Phase 1 retains sixteen complete prototype source snapshots, three compiled WASM/glue variants, the frozen contract and original reports; these do not depend on an old commit URL surviving.
- Keep the source branch `t3/interactive-location-results` after squash. It retains the full eight-commit experiment history through `d3d381f`, including prototype checkpoint `874c039` and clean no-go removal `3e9b540`.
- Authenticated repository policy inspection: squash allowed; automatic branch deletion disabled; auto-merge disabled. Do not change repository settings or use administrator bypass.
- Merge with `gh pr merge --squash --match-head-commit <verified-head>` only after that exact head's required checks/reviews permit it. Do not pass `--delete-branch`, `--admin`, or force-push flags.
- Final review synthesis and every finding/disposition will be committed with the PR. If required checks/reviews remain pending, watch the PR instead of polling or claiming it merged.

Published preservation plan: https://github.com/baladithyab/baladithyab.github.io/pull/60#issuecomment-6843336967
