# Review of list 5, second look (reviewer, at ce42572)

- [x] 1. List and inputs: 8 changes in /tmp/rl5/copy2 (/tmp/rl5/scripts/mut2.mjs), all killed by encoder-requests.test.ts (21 tests).
- [x] 2. Lists 1 to 4: 8 files, 155 pass. One byte of each fixture copy of lists 3 and 4: each caught.
- [x] 3. README: R7 fails (the node did not report the hash; sent.extrinsic_hash null). 6 README changes killed by Z1 to Z5. A coherent T4 era edit with SHA256SUMS recomputed is killed only by review4-keys.
- [x] 4. run-files: drop, add, one byte: all killed. A byte no assertion reads, with SHA256SUMS recomputed: alive (R5 in review4-run.test.mjs fails).
