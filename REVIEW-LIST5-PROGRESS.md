# Review of list 5 (reviewer, at ae31282)

- [x] Build observatory and imd-flop: both exit 0.
- [x] Attack 1: the eight keys a third way (own twox128, noble blake2b). research/2026-11-12-encoder-devnet-test/review4-keys.test.mjs: 3 pass. Held.
- [x] Attack 2: 14 changes in a copy (/tmp/rl5/copy), script /tmp/rl5/scripts/mut.mjs, encoder-requests.test.ts: all 14 killed. Held.
- [x] Attack 3: 22 inputs, each held to its field; the list positions in fields are held by name lookups (T3, FORCE_OPEN, step index). Changes of field in attack 2 all killed. Held.
- [x] Attack 4: 5 files, 97 pass. One byte of fixture requests.json: 3 fail; of fixture requests-inputs.json: 3 fail plus 2 files fail to load. rerun-requests lost the writer test (moved to encoder-requests, for list 5). Held.
- [x] Attack 5: 9457ffd moves rerunMetadata and RERUN_RESULTS, adds reviewedMetadata with 3 tests, and the list-5 draft. Same logic. Held.
- [x] Attack 6: sha256 of results.json is a0c853cd...267f, held. review4-readme.test.mjs: 3 fail (R1 balances in a committed file, R2 mortal era not in record, R3 declared spend not in record). results.test.mjs 6 pass.
- [x] Attack 7: mutate.mjs takes files, not ids; the 8 applied by hand in /tmp/rl5/copy: 8 killed. README mutants review4-mutants.json: 6 alive under results.test.mjs.
