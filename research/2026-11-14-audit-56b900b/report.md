# Audit report

> Audit the chain path of uxp-labs/flop-devnet-lab at this commit: the code that will let an IMD worker open and pay a FLOP compute channel through a session key. None of it is used by a command yet. The spend path (imd-flop booking, ledger, caps) was audited at 33f3b9f and is out of scope here, as are viewer/, spend-guard/, imd-hire/ and tclk-rehearsal/.
> Scope:
> A. The chain encoder, imd-flop/src/chain/ (extrinsic.ts, payload.ts, scale.ts, era.ts, calls.ts, fields.ts, reader.ts, describe.ts, table.ts, runtimes.ts, shape.ts). It encodes and signs FlopSessionKeys.execute_via_session around one ComputeChannel call (open_channel, top_up_escrow, timeout, force_open, expire_force_open) for runtime spec 1014020.
> B. The chain reads, imd-flop/src/chain-read/ and imd-flop/src/node-rpc.ts. They read a session's state and a block's events from a FLOP node and can send nothing.
> C. The decoder they rest on, observatory/src/scale/ (block.ts is its one door; shape.ts, decode.ts, storage-key.ts, metadata.ts, reader.ts) with the reviewed shape files observatory/shapes/*.json (format decoder-shape@3, 16 stated storage entries, specs 1014014 and 1014020).
> Work offline and read only: no network, no faucet, no keys, no call to any node, nothing signed with a real key, nothing sent. Do not run as root: some imd-flop tests need a read only file.
> Run first: in observatory, npm ci then npm run build then npm test (77 test files). In imd-flop, npm ci then npm test (1608 tests; it needs the observatory built first). The reference decoder and encoder for tests is polkadot-api (dev dependency of both packages). Recorded chain data is under observatory/fixtures/recording-*/ and the metadata of both specs is on the tape of recording-20261112080132-05842a6db1e9c890.
> The promises under audit are stated in imd-flop/README.md (sections "Chain encoder" and "Chain reads"), observatory/RULES.md sections 9 and 10 and observatory/README.md (the decoder). In short: nothing is signed unless the call bytes read back as the input; the declared spend is computed, never passed; a read answers a known value or unknown with a reason and never a default for a value the node did not state; chain data is decoded only for a reviewed runtime, only for a stated entry, only under that entry's key.
> Look for:
> 1. Encoder bytes. Any input, hostile ones included (a Proxy, a getter, a typed array with a patched length, a subclass, values at the edges of u32, u64 and u128), for which the sign function is called with bytes the chain would decode as another inner call, amount, channel, sla, signer, nonce, era or tip than the fields and words the encoder returns. Any way a spend, an era or a tip is taken from the caller. A declared spend that is not what the inner call moves. SCALE that differs from the reference for any of the five calls (compact integers, options, enum indices, field order). The signing payload rule for payloads over 256 bytes. The mortal era at its edges (period 64, a birth block at a multiple of the period, block 0, the last valid block).
> 2. The encoder's table. Any pallet index, call index, field order or type in imd-flop/src/chain/runtimes.ts that is not what the recorded 1014020 metadata gives, and anything in it typed by hand. Any runtime other than the table's that is not refused before signing.
> 3. Chain reads. Any node answer (a frame with another id, with both result and error, a list, a huge answer, hex in upper case or of odd length, null against "0x", a head that changes between calls, a header whose number and hash disagree) for which a read answers a known value the node did not state, or throws. Any path that takes a default for a stored value or a stored value for a default: a session that is not stored, a session nonce that is not stored (its default is 0), a breaker that is not stored. A session record that names another owner or delegate and is accepted. Any way a method other than the five read methods reaches the wire, or a socket is opened outside node-rpc.ts.
> 4. The decoder's door. Any bytes for which decodeStorageValue or decodeBlockEvents answers decoded with a value that differs from the reference decoder, for the 16 stated entries at both specs. A value accepted under a wrong key (another entry, other key parts, extra key bytes), trailing bytes accepted, an entry the shape does not state decoded, a runtime not on the reviewed list decoded, a shape file that is not the reviewed one accepted (also a decoder-shape@2 file from observatory/fixtures/shapes-at-2). Whether stored and not stored are always told apart (the default of System.Account is not zero). An input that makes the decoder pass its stated budgets, loop, or fail with anything but its own ScaleError. A field or variant name from metadata (__proto__, constructor, toString) that changes an object's prototype or shadows a value.
> 5. Storage keys (observatory/src/scale/storage-key.ts and imd-flop/src/chain-read/keys.ts, key-table.ts). Any key that differs from the reference for the stated entries, and any two different key parts that give the same key.
> 6. The cross check (imd-flop/src/chain-read/cross-check.ts). Any session state and SessionCallExecuted event accepted together though their totals disagree, also with amounts above 2^53 and with decimal text against numbers.
> 7. One fact to hold the code against: on devnet a refused session call does not move the session nonce (research/2026-11-12-encoder-devnet-test/results.final.json: session_nonce is 1 after T3, T4 and T5 and 2 after T6). Say whether anything in scope assumes otherwise.
> 8. Words. Any sentence in the README and RULES sections named above that the code does not keep.
> 9. The tests. Try to keep a wrong rule alive against imd-flop/test/chain-*.test.ts and review-chain-read-*.test.ts, and against the observatory's mutants (observatory/mutants/*.json, run by node scripts/mutate.mjs <file>). Name any rule with no test that fails without it.
> For every finding give file and line, severity, impact and a reproduction that runs offline, and say whether it is inside or outside the stated promise. Mark every statement as confirmed (you ran it), inferred or unknown. Say which checks you ran and which you only read.

| | |
|---|---|
| Repository | https://github.com/uxp-labs/flop-devnet-lab.git |
| Commit | `56b900b2f92b16e212afeb962883bd02dcc21d80` |
| Job | `8bdcca82-782f-442e-bc78-7c6e5321b501` |
| Judged | 2026-11-14 02:17 UTC |
| Findings | 4 low · 5 info |

Four agents audited the code as it is at `56b900b`, each in one area (math, permissions, economics, control flow),
and a judge reproduced, merged and ranked what they found, then read the code once more itself. Nothing in the repository was changed or deployed.

## Findings

### 1. Low: readBlockEvents re-reads block.hash and block.number from the caller's object after the canonical check, so an accessor passes the check with the canonical hash and then reads a sibling block

`imd-flop/src/chain-read/read.ts:126`

```
  if (canonical.value !== block.hash) return unknown(`block ${block.number} ${block.hash} is not canonical: the node's hash at ${block.number} is ${canonical.value}`);
```

CONFIRMED (ran it). readBlockEvents(t, block) reads block.hash at lines 126, 127, 130, 132 and 137 and block.number at 123, 124, 126, 129 and 137, each time straight from the caller's object. Only the read at line 126 is compared with chain_getBlockHash(number); the header (127), the pin (130), the System.Events read (132) and the hash reported in the result (137) each take a fresh read. A hash property that is an accessor (or a Proxy get trap) answering the canonical hash A on the first read and a sibling hash B afterwards makes the read 'known', with the events the node holds at B, labelled with hash A. Nothing checks that the events are those of a canonical block. imd-flop/README.md line 149 ('Events are read only at a block the node reports finalized and canonical') is not kept for a caller object with an accessor, and the reads do not apply the rule H1 the encoder applies to its own input (fields.ts ownValue refuses an accessor; extrinsic.ts reads every field once into a snapshot). Impact: a future caller that hands in a non-plain object (a class instance with a getter, a Proxy) can get a non-canonical block's events reported under the canonical hash, and crossCheck then compares a session state with those events. The node's answers are not at fault, so the promise about node answers holds (a plain {number, hash: B} is refused: confirmed). Outside the stated promise about node answers, inside the README sentence quoted. Fix: read block.number and block.hash once at the top (own-property reads as fields.ts ownValue does, or at least one local copy) and use the copies everywhere, including atOf.

**Reproduction**

Offline, after `npm run build` in observatory and `npm test` in imd-flop (dist/ exists). Scripted transport from observatory/fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl: A = recorded hash of 3528528 (0x187a4c5b...), B = 0xbb..bb (32 bytes, a sibling at the same height, not on the tape), C = recorded hash of 3528527, P = C (A's parent). chain_getFinalizedHead -> A; chain_getHeader(A or B) -> {number: '0x35d7d0', parentHash: P}; chain_getBlockHash(3528528) -> A; state_getMetadata(P) -> the metadata the tape holds at P; state_getStorage(k, A) -> tape at A; state_getStorage(LRU key, B) -> A's recorded LRU bytes; state_getStorage(System.Events key, B) -> C's recorded System.Events. Then:
  let i = 0; const seq = [A, B, B, B, A];
  const r = await readBlockEvents(transport, { number: 3528528, get hash() { return seq[i++] ?? A; } });
Expected: unknown (B is not canonical; readBlockEvents(transport, {number: 3528528, hash: B}) is unknown: 'block 3528528 0xbb.. is not canonical: the node's hash at 3528528 is 0x187a...'). Actual: r.kind === 'known', r.value.hash === A, r.value.events.length === 6 (C's events) while the honest read of A gives 64 events. Transport log: chain_getFinalizedHead | chain_getHeader(A) | chain_getBlockHash(3528528) | chain_getHeader(B) | state_getStorage(LRU, B) | state_getMetadata(P) | state_getStorage(Events, B).

### 2. Low: README says a getter is refused and a Proxy's get trap is not used, but the signer's publicKey and sign and the runtime id's four names are read by plain property access (getters run and are accepted,

`imd-flop/src/chain/extrinsic.ts:130`

```
  const publicKey = bytesOf((signer as { publicKey?: unknown }).publicKey, 32, "the device public key");
```

CONFIRMED (ran it). imd-flop/README.md lines 135, 136 and 139 ('Chain encoder') say 'A field must hold its value: a getter is refused', 'An input field that is an accessor is refused, and a Proxy's get trap is not used', and that 'a field missing, extra or a getter' is refused before the sign function is called. The top-level input, the inner call, the sla and the birth block go through fields.ts takeFields/ownValue, which refuse accessors and never use a get trap (confirmed: birth with `get number()` is refused BAD_INPUT 'the birth block.number is an accessor, not a value'). Two parts of the input are exceptions: (1) takeSign reads signer.publicKey (extrinsic.ts:130) and signer.sign (:131) with ordinary property access, so a getter on either runs and its value is accepted, a Proxy signer's get trap is used, and extra keys on the signer object are not refused; (2) table.ts runtimeFor reads id.specName, id.specVersion, id.transactionVersion and id.genesisHash (table.ts:75-78) by plain access, so a getter or a Proxy get trap on the runtime id runs and is accepted. Impact on bytes: none. Each value is read once and copied (bytesOf), and the strict reader verifies the signature against the key in the extrinsic, so a getter that lies on a later read changes nothing signed. The three README sentences are unconditional and are false for these six fields, which are the one input object that runs caller code (the signer) and the one that selects the table line (the runtime id). No test covers a getter on the signer or a Proxy as the runtime id (chain-snapshot.test.ts covers owner, sessionNonce, inner fields, sla and birth). Inside the stated promise (words vs code, item 8). Fix: read the signer's two fields and the runtime id's four names through ownValue (refusing accessors, listing own keys as takeFields does), or narrow README lines 135-136 and 139 to name the signer and the runtime id as read by plain property access. Merged from three specialist findings (permissions, economics, flow) that reproduce the same mechanism.

**Reproduction**

Offline, from the repo root after imd-flop/dist exists:
  const { signSessionCall, encodeSessionCall } = await import('./imd-flop/dist/chain/extrinsic.js'); const { RUNTIMES } = await import('./imd-flop/dist/chain/runtimes.js'); const { ed25519 } = await import('./imd-flop/node_modules/@noble/curves/ed25519.js');
  const RT = RUNTIMES[0]; const ID = { specName: RT.specName, specVersion: RT.specVersion, transactionVersion: RT.transactionVersion, genesisHash: RT.genesisHash };
  const seed = new Uint8Array(32).fill(7); const pk = ed25519.getPublicKey(seed);
  const base = { runtime: ID, owner: new Uint8Array(32).fill(1), inner: { call: 'timeout', channel_id: new Uint8Array(32).fill(2) }, sessionNonce: 1n, accountNonce: 0, birth: { number: 100, hash: new Uint8Array(32).fill(9) } };
  let hits = 0; signSessionCall({ ...base, signer: { get publicKey() { hits++; return pk; }, sign: (m) => ed25519.sign(m, seed) } }); // expected per README: BAD_INPUT (a getter). Actual: accepted, 198 byte extrinsic, hits === 1
  signSessionCall({ ...base, signer: { publicKey: pk, get sign() { return (m) => ed25519.sign(m, seed); } } }); // actual: accepted
  signSessionCall({ ...base, signer: { publicKey: pk, sign: (m) => ed25519.sign(m, seed), extra: 1 } }); // expected: refused (a field extra); actual: accepted
  const trapped = []; signSessionCall({ ...base, runtime: new Proxy(ID, { get(t, k) { trapped.push(k); return t[k]; } }), signer: { publicKey: pk, sign: (m) => ed25519.sign(m, seed) } }); // expected: the get trap is not used; actual: accepted, trapped = ['specName','specVersion','transactionVersion','genesisHash']
  encodeSessionCall({ runtime: { specName: ID.specName, get specVersion() { return ID.specVersion; }, transactionVersion: ID.transactionVersion, genesisHash: ID.genesisHash }, owner: base.owner, inner: base.inner, sessionNonce: 1n }); // expected: refused (a getter); actual: accepted, 92 call bytes
  Control: signSessionCall({ ...base, birth: { get number() { return 100; }, hash: new Uint8Array(32).fill(9) }, signer: {...} }) is refused BAD_INPUT 'the birth block.number is an accessor, not a value'.

### 3. Low: README 'Everything src/chain exports is frozen where it is defined' is not kept for the exported classes: ByteReader.prototype is writable and patching it changes what the strict reader and the read-b

`imd-flop/src/chain/scale.ts:52`

```
export class ByteReader {
```

CONFIRMED (ran it). imd-flop/README.md line 141 (rule H7) says 'Everything `src/chain` exports is frozen where it is defined'. The exported classes ByteReader (scale.ts:52) and ChainEncodeError (errors.ts) are not frozen and their prototypes are writable: Object.isFrozen(ByteReader) === false, Object.isFrozen(ByteReader.prototype) === false, and the same for ChainEncodeError. The strict reader (reader.ts) and the encoder's read-back check (extrinsic.ts checkedCallBytes) both stand on ByteReader, so a write to ByteReader.prototype changes what readCall, readExtrinsic and describeCall report; because callBytes and the read-back use the same patched reader, the READ_BACK comparison does not notice. The test that holds rule H7, test/chain-frozen.test.ts, skips every exported function at line 55 (`if (typeof value === "function") continue;`), so the rule has no test that fails without it for classes. Impact: low. This needs code in the encoder's own process, which could already replace modules; it is a words-vs-code gap and a test gap, not a remote attack. Inside the stated promise (README line 141). Fix: Object.freeze(ByteReader) and Object.freeze(ByteReader.prototype) (and ChainEncodeError) where they are defined, and make chain-frozen.test.ts walk exported functions and their prototypes; or narrow the README sentence to objects and arrays.

**Reproduction**

Offline, from the repo root after imd-flop/dist exists:
  const { ByteReader } = await import('./imd-flop/dist/chain/scale.js'); const { readCall } = await import('./imd-flop/dist/chain/reader.js'); const { encodeSessionCall } = await import('./imd-flop/dist/chain/extrinsic.js'); const { RUNTIMES } = await import('./imd-flop/dist/chain/runtimes.js');
  const RT = RUNTIMES[0]; const ID = { specName: RT.specName, specVersion: RT.specVersion, transactionVersion: RT.transactionVersion, genesisHash: RT.genesisHash };
  const bytes = encodeSessionCall({ runtime: ID, owner: new Uint8Array(32).fill(1), inner: { call: 'top_up_escrow', channel_id: new Uint8Array(32).fill(2), additional: 5n }, sessionNonce: 1n });
  Object.isFrozen(ByteReader), Object.isFrozen(ByteReader.prototype) // expected per README line 141: true, true. Actual: false, false
  readCall(ID, bytes).spend // 5n
  const o = ByteReader.prototype.uint; ByteReader.prototype.uint = function (n) { const v = o.call(this, n); return n === 16 ? 0n : v; }; // expected: throws (frozen prototype)
  readCall(ID, bytes).spend, readCall(ID, bytes).inner.additional // expected: 5n, 5n. Actual: 0n, 0n

### 4. Low: RULES.md section 9 says the decoder reads six storage entries 'today' (STATED_ENTRIES), but STATED_ENTRIES holds 16 and the door decodes the other ten

`observatory/RULES.md:1073`

```
  its name and variant index, its fields and its phase. The storage it reads today: System.Events
```

CONFIRMED (ran it). observatory/RULES.md lines 1073-1075 say: 'The storage it reads today: System.Events and System.LastRuntimeUpgrade, ComputeChannel.Channels, and FlopSessionKeys Sessions, SessionNonces and CircuitBreakers (`STATED_ENTRIES`).' That is six entries. STATED_TABLE and the derived STATED_ENTRIES in observatory/src/scale/shape.ts hold sixteen, and the same section lists 'The 16 stated entries' at lines 1140-1144. decodeStorageValue decodes any of the sixteen (confirmed: System.Account and FlopSessionKeys.SessionNonces with answer null at spec 1014020 decode with stored: false). A reader of the first bullet is told that DelegateSessions, FailedAcks, Models, Miners and the rest are not decoded by this code, which is false since the decoder-shape@3 round; the two lists in one section contradict each other. No code defect. Inside the stated promise (RULES.md section 9 is named by the task). Fix: replace the six-entry sentence with a reference to the sixteen stated entries of STATED_TABLE (or 'the 16 stated entries below'). Merged from two specialist findings (economics, flow).

**Reproduction**

Offline, after `npm run build` in observatory:
  cd observatory && node -e 'import("./dist/scale/shape.js").then(({STATED_ENTRIES}) => console.log(STATED_ENTRIES.length, STATED_ENTRIES.map((e) => e.join(".")).join(", ")))'
Expected per RULES.md lines 1073-1075: 6. Actual: 16 (System.Events, System.LastRuntimeUpgrade, System.Account, ComputeChannel.Channels, ComputeChannel.FailedAcks, ComputeChannel.ChannelAuthoredOpenedAt, FlopSessionKeys.Sessions, .SessionNonces, .CircuitBreakers, .DelegateSessions, ModelRegistry.Models, .MeasuredRoots, .AllowedDecodePolicies, MinerStaking.Miners, HwCalibration.CalibrationVersions, .LastInitialCalibration). Also, with the 1014020 metadata from fixtures/recording-20261112080132-05842a6db1e9c890/tape.jsonl (sha256 91294eb6...), the committed shapes/tzkv-runtime-1014020.json and a LastRuntimeUpgrade of compact(1014020) ++ str('tzkv-runtime'), decodeStorageValue({ specName: 'tzkv-runtime', specVersion: 1014020, metadata, lastRuntimeUpgrade, shapeText, pallet: 'System', entry: 'Account', keys: [acct], key: storageKey(md, 'System', 'Account', [acct]), answer: null }) answers { decoded: true, stored: false, ... }, an entry the sentence says is not read.

### 5. Info: Pin refusal 4 (the shape derived again from the metadata differs from the file) has no test that fails without it: the mutant survives test/shape.test.ts and the whole observatory suite

`observatory/src/scale/shape.ts:561`

```
    if (derived !== i.shapeText) return refuse(`the shape derived from the metadata differs from ${reviewed.shapeFile}`);
```

CONFIRMED (ran it). RULES.md section 9 lists five pin refusals and says refusal 4 holds deriveShape's code to the review. Replacing `if (derived !== i.shapeText) return refuse(` with `if (false) return refuse(` survives test/shape.test.ts through the project's own runner (node scripts/mutate.mjs with a one-mutant file: outcome 'survived', controls pass, exit 0). In a scratch copy of the package with the same mutation, the whole suite (vitest run) shows no failure in any scale, shape or decoder test; the only failures were workflow and schema tests broken by the copy's paths. mutants/decoder.json holds shape.ts mutants but none for this line, and no test asserts the refusal's words 'the shape derived from the metadata differs' (the 'differs from' matches in test/shape-at-2.test.ts and test/helpers/shape-file.ts are the write-shape compare script's words, not pinLine's). With the committed files refusals 2 and 3 (metadata sha256, shape file sha256) make refusal 4 unreachable, so a regression that removed it would not be noticed. Impact: none on current behaviour; a documented rule is unguarded (task item 9). Inside the stated promise. Fix: a test that reaches pinLine with a shape text whose sha256 is registered but whose text differs from the derivation (through a test seam over REVIEWED or deriveShape) and asserts the refusal names 'differs from'; and add the mutant to mutants/decoder.json.

**Reproduction**

From observatory/ (built, tests passing): write a mutants file
  [{"id":"pin-derived-unchecked","file":"src/scale/shape.ts","find":"if (derived !== i.shapeText) return refuse(","replace":"if (false) return refuse(","test":"test/shape.test.ts","why":"refusal 4"}]
and run `node scripts/mutate.mjs <that file>`. Expected: killed. Actual: 'mutants not a pass: 1 mutants, 0 killed, 1 survived', 'not killed: pin-derived-unchecked survived', controls control-pass, exit 0. `grep -rn 'derived from the metadata differs' test/` finds nothing.

### 6. Info: readEra's phase-below-period rule has no test that fails without it: removing it leaves all chain and chain-read tests passing

`imd-flop/src/chain/era.ts:43`

```
  if (phase >= period) refuse("BAD_BYTES", `an era phase ${phase} not below its period`);
```

CONFIRMED (ran it). Task item 9 asks for any rule with no test that fails without it. The strict reader's check that a mortal era's phase is below its period (Substrate's own Era::decode rule) is one. With the line replaced by `if (false) refuse(...)` in a scratch copy of imd-flop (node_modules linked), `npx vitest run test/chain-*.test.ts test/review-chain-read-*.test.ts` passes every test (476 passed; the 2 failures were chain-words tests that read contract/rules.json by a path the copy did not have). Byte-level impact: nil. readExtrinsic (reader.ts:134) compares the phase with birth.number % era.period, always below 64, so a phase of 1024 is still refused there with another message, and the encoder never writes such a phase (mortalEra takes birth % 64). Nothing is signed or accepted that the chain would read otherwise. Inside the stated promise; a test-coverage note, not a behaviour defect. Fix: a test that reads era bytes 0x05 0x40 (period 64, phase 1024) through readEra and asserts the refusal 'not below its period'.

**Reproduction**

Offline. In a copy of imd-flop (with node_modules, observatory and research linked beside it), change imd-flop/src/chain/era.ts line 43 from `if (phase >= period) refuse(` to `if (false) refuse(` and run `npx vitest run test/chain-*.test.ts test/review-chain-read-*.test.ts`. Expected: at least one test fails. Actual: Tests 476 passed (the two failures are ENOENT on contract/rules.json from the copy, not the era). Direct input on the unmutated dist: readEra(new ByteReader(Uint8Array.of(0x05, 0x40))) refuses BAD_BYTES 'an era phase 1024 not below its period'; under the mutant it returns { period: 64, phase: 1024 }.

### 7. Info: answerOf is documented as 'Never throws' but throws when a frame's property is a throwing accessor (not reachable from the wire)

`imd-flop/src/node-rpc.ts:30`

```
    const e = m.error;
```

CONFIRMED (ran it). The doc comment at node-rpc.ts:19-25 ends 'Never throws.' answerOf reads m.error (line 30) and m.jsonrpc / m.id (line 34) with plain property access, so a frame object whose property is an accessor that throws makes answerOf throw the caller's error. Not reachable from a node: rpcCall only passes objects from readOutsideJson (JSON.parse output has no accessors), and rpcCall's onmessage try/catch would turn such a throw into 'rpc returned malformed JSON'. Outside the stated README promise (the frame rule for rpcCall, which holds); it is the function's own comment that is not kept. Fix: read the fields through Object.getOwnPropertyDescriptor inside a try, or drop 'Never throws' from the comment.

**Reproduction**

Offline: const { answerOf } = await import('./imd-flop/dist/node-rpc.js'); answerOf({ jsonrpc: '2.0', id: 1, get error() { throw new Error('boom'); } }) // expected per the comment: { ok: false, ... }; actual: throws Error('boom').

### 8. Info: Two property tests exceed the 20 s vitest timeout when the whole imd-flop suite runs, so `npm test` is red with no rule broken

`imd-flop/test/review-p3-properties.test.ts:255`

```
  it("2000 random signed calls: no two different extrinsics share one description", () => {
```

CONFIRMED (ran it). imd-flop vitest.config.ts sets testTimeout 20000. In two full runs of `npm test` on this machine (observatory built first), test/review-p3-properties.test.ts:255 ('2000 random signed calls: no two different extrinsics share one description') failed with 'Test timed out in 20000ms'; in one of them test/decision-properties.test.ts ('sequences of three steps over every trusted read ...') failed the same way. Both files pass when run alone (52 tests, 32 s total), so the failure is timing under the suite's parallel load, not logic. Impact: the suite the README names as the check of the encoder is red on a loaded or slow machine, so a real regression and a slow machine look alike. Outside the stated promise (test infrastructure). Fix: give these two tests their own timeout (it(..., 120_000)) or split the 2000-call loop into smaller cases.

**Reproduction**

cd imd-flop && npm ci && npm test (with ../observatory built). Observed here: 'FAIL test/review-p3-properties.test.ts > H (P8): the words > 2000 random signed calls: no two different extrinsics share one description -- Error: Test timed out in 20000ms', and in one run also 'FAIL test/decision-properties.test.ts > the hold floor > sequences of three steps ...' with the same error. Then `npx vitest run test/review-p3-properties.test.ts test/decision-properties.test.ts` alone: 2 files, 52 tests passed in 32 s. (Eight other failures in lock.test.ts, review-hold-2.test.ts, audit-v3.test.ts and booking.test.ts appear only when the suite runs as root; they pass under `setpriv --inh-caps=-all --bounding-set=-all npx vitest run ...`, as the tests themselves ask.)

### 9. Info: rpcCall takes and JSON-parses a whole frame before any cap applies, and has no onclose handler: an oversize frame is handled only by the engine's memory, and a clean close waits out the 15 s timeout (

`imd-flop/src/node-rpc.ts:59`

```
        const a = answerOf(readOutsideJson(String(ev.data)));
```

INFERRED (read the code; no socket may be opened in this review, the test setup disables WebSocket and the sandbox denies localhost). Two bounded-resource gaps in the one socket function. (1) Size: rpcCall takes the whole message as String(ev.data) and parses it with readOutsideJson, whose header says it has no depth limit and which has no size limit; the WebSocket is Node's built-in one created with no message-size option. The caps of chain-read/node.ts (bytesWithin line 107, measured line 134) are applied to the parsed result, after rpcCall resolved. So a node that answers a frame of several GiB makes the process allocate the string and the parsed value before any cap is consulted; the likely outcome is an out-of-memory abort rather than the 'unknown with a reason' README line 152 promises for 'an answer over its cap'. (2) Close: rpcCall settles on a message, an error or the timer, and a peer that closes the socket cleanly (close frame 1000/1001, as a node does on shutdown or when dropping an idle client) fires onclose and not onerror, so the promise waits the whole timeoutMs (15000 by default) before 'rpc timeout'. The read then correctly becomes unknown, so no wrong value is answered; the cost is latency (readSessionState makes seven calls, readBlockEvents eight). Impact: low availability effect against a hostile or broken node; nothing is signed or spent. At the edge of the stated promise: the caps are documented as the bound, and the frame reaches the parser before them. Fix: reject with a fixed reason when ev.data.length exceeds a frame cap (for example 2 + 2 * CAPS.metadata characters, the largest any read accepts) before String()/parse, or construct the WebSocket with a maxPayload where the runtime supports one; and add ws.onclose = () => finish(new Error('rpc socket closed before an answer')). Merged from two specialist findings (flow: huge frame; permissions: onclose).

**Reproduction**

Reading check, offline: `grep -n 'maxPayload\|length\|cap\|onclose' imd-flop/src/node-rpc.ts imd-flop/src/outside-json.ts` shows no bound before parse and no onclose handler; the only caps are in imd-flop/src/chain-read/node.ts bytesWithin (line 107) and measured (line 134), both applied after rpcCall resolved. To observe outside this sandbox: (1) serve a JSON-RPC frame {"jsonrpc":"2.0","id":1,"result":"0x" + "00".repeat(N)} with N large enough to exceed the process heap and call readSessionState(nodeTransport(url), owner, delegate); expected per README line 152: unknown with the cap's reason; expected from the code: an out-of-memory abort. (2) start a WebSocket server whose connection handler calls socket.close(1000) on open and time rpcCall(url, 'chain_getFinalizedHead', [], 15000); expected: rejects promptly; from the code: rejects after 15 s with 'rpc timeout'.

---

Judge's submission `4b91defa3fa887ba309514f4beb6544f52596341db43e57add85f69a7a717233`, accepted on the IdentityMD network. Acceptance means the report met the job's checks;
it is not a guarantee that the code has no other defects.
