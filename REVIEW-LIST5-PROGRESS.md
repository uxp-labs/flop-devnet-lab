# Review of list 5 (reviewer, at ae31282)

- [x] Build observatory and imd-flop: both exit 0.
- [x] Attack 1: the eight keys a third way (own twox128, noble blake2b). research/2026-11-12-encoder-devnet-test/review4-keys.test.mjs: 3 pass. Held.
- [x] Attack 2: 14 changes in a copy (/tmp/rl5/copy), script /tmp/rl5/scripts/mut.mjs, encoder-requests.test.ts: all 14 killed. Held.
- [ ] Attack 3: inputs and field paths.
- [ ] Attack 4: the fourth list.
- [ ] Attack 5: the move (9457ffd).
- [x] Attack 6: sha256 of results.json is a0c853cd...267f, held. review4-readme.test.mjs: 3 fail (R1 balances in a committed file, R2 mortal era not in record, R3 declared spend not in record). results.test.mjs 6 pass.
- [ ] Attack 7: the eight new mutants.
