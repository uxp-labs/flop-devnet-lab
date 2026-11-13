# Files of the decoder-shape@2 days

Taken from main at commit c153eb2, before round 29 wrote them again at decoder-shape@3, with
`git show c153eb2:<path>`. SHA256SUMS holds their sha256.

- `tzkv-runtime-1014014.json`, `tzkv-runtime-1014020.json`: `observatory/shapes/<file>`, the two
  reviewed shape files at decoder-shape@2, whose sha256 were the shapeSha256 of the two REVIEWED
  lines then. test/shape-at-2.test.ts holds that every reader of a shape refuses them.
- `session-rerun-results.json`: `research/2026-11-12-session-rerun-1014020/results.json` as the
  fill wrote it with decoder-shape@2. test/rerun-results.test.ts holds that the fill run again
  changed nothing else in it.
