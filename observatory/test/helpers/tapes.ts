// The anchor answer for a tape recorded before live runs read one back (RULES.md 1.1). Such a tape
// holds no chain_getBlockHash(h) call, so a replay of it on a log that names an anchor asks for one
// the tape does not hold, and is refused (test/anchor.test.ts shows it on the real tapes). A test
// that needs such a replay to go on wraps the tape with answeringAnchor: the call is answered from
// the table below, never from the tape. Every answer is synthetic, made to fit the chain the
// fixture's own tape shows, and says why.
//
// The same holds for the two reads of the upgrade watch (RULES.md 7.2): the real tapes were recorded
// before runs made them, so a replay of one that reads a finalized head is refused at the first
// state_getStorage call, unless a test answers both from UPGRADE_ANSWERS below (answeringUpgrade).
import { readFileSync } from "node:fs";
import { UPGRADE_KEYS } from "../../src/upgrade-watch.js";
import { TransportError } from "../../src/transport.js";
import type { TapeAnswer } from "../../src/tape.js";
import type { Transport } from "../../src/transport.js";

/**
 * The block hashes the real readings on the data branch logged as finalized heads, by height. The
 * real devnet chain held these blocks at these heights when it was read (fixtures/published-*).
 */
export const REAL_FINALIZED: Readonly<Record<number, string>> = {
  3457487: "0x39ec5c58218ed6f195942411d94a1d7d1198a3c8421f0eaf5a3f68ff7b31a23f",
  3458329: "0xbd9029954f5d4d3c82e8fc059aeb0c5c06e96ba8a8d42d2c4efc916cd8aa66fa",
};

/** The real chain's hash at a height it was logged at; a height no real reading logged is a fault in the test. */
function realChain(height: number): TapeAnswer {
  const hash = REAL_FINALIZED[height];
  if (hash === undefined) throw new Error(`no real reading logged block ${height}`);
  return { result: hash };
}

/** For each fixture whose tape holds no anchor call, what its chain gives at an earlier finalized height, and why. */
export const ANCHOR_ANSWERS: Readonly<Record<string, (height: number) => TapeAnswer>> = {
  // Real readings of the real chain: it still holds every block a real reading logged.
  "published-2026-11-11-0808": realChain,
  "published-2026-11-11-0823": realChain,
  // The same chain, 600 s on, holding the same finalized block.
  "memory-stuck": realChain,
  // Its finalized header is block 3457487 under the hash 0xc4..c4: that is the hash at that height now.
  "memory-changed-hash": (h) => (h === 3457487 ? { result: "0x" + "c4".repeat(32) } : { result: null }),
  // Its best block is below 3457487, and so is everything it holds above its finalized head: no block there.
  "memory-finalized-below-floor": () => ({ result: null }),
  "memory-best-below-floor": () => ({ result: null }),
  // A chain started again, at block 124: no block at any height a reading of the old chain logged.
  "memory-other-genesis": () => ({ result: null }),
  // Every call fails with the socket's error; this one would too.
  "memory-rpc-down": () => ({ error: "rpc socket error" }),
};

/**
 * The transport, but the anchor read back (chain_getBlockHash at a height other than 0) is answered
 * by answer, and never reaches the transport. The genesis read, chain_getBlockHash(0), still does.
 */
export function answeringAnchor(inner: Transport, answer: (height: number) => TapeAnswer): Transport {
  return {
    trust: inner.trust,
    label: inner.label,
    rpc: async (m, p) => {
      if (m !== "chain_getBlockHash" || p[0] === 0) return inner.rpc(m, p);
      const a = answer(p[0] as number);
      if ("error" in a) throw new TransportError(a.error);
      if ("refused" in a) throw new Error(a.refused);
      return a.result;
    },
    httpGet: (u) => inner.httpGet(u),
    now: () => inner.now(),
    close: () => inner.close(),
  };
}

/** The two answers of the upgrade watch for a tape that holds neither. */
export interface UpgradeAnswers {
  lastRuntimeUpgrade: TapeAnswer;
  authorizedUpgrade: TapeAnswer;
}

const RESULTS = JSON.parse(readFileSync(new URL("../../../research/2026-11-12-runtime-upgrade/results.json", import.meta.url), "utf8"));
/**
 * The chain the real tapes read, on 2026-11-11, ran tzkv-runtime 1014014, the spec each of them read
 * with state_getRuntimeVersion: the record of that runtime is the one results.json gives at
 * boundary.0.last_runtime_upgrade.hex. No upgrade was authorised then: results.json reads none at
 * authorization.authorized_upgrade_at.0 (block 3513543, later than every block the real tapes read),
 * and finds the first at 3528478 by bisection, which shows one change, not that none came and went
 * before. Both answers are synthetic.
 */
const ON_1014014: UpgradeAnswers = {
  lastRuntimeUpgrade: { result: RESULTS.boundary[0].last_runtime_upgrade.hex },
  authorizedUpgrade: { result: RESULTS.authorization.authorized_upgrade_at[0].value },
};

/** For each real tape that reads a finalized head, the two answers of the upgrade watch, and why. */
export const UPGRADE_ANSWERS: Readonly<Record<string, UpgradeAnswers>> = {
  // First runs on 2026-11-11 at 08:08 and 08:23 UTC, each at spec 1014014 by its own tape.
  "published-2026-11-11-0808": ON_1014014,
  "published-2026-11-11-0823": ON_1014014,
  // The reading at 12:39 UTC, at spec 1014014 by its own tape. The one at 12:06 had the RPC down,
  // read no finalized head and so makes neither call.
  "published-2026-11-11-1239": ON_1014014,
};

/**
 * The transport, but the two reads of the upgrade watch, state_getStorage of System.LastRuntimeUpgrade
 * and of System.AuthorizedUpgrade, are answered by answers and never reach the transport. Any other
 * call still does.
 */
export function answeringUpgrade(inner: Transport, answers: UpgradeAnswers): Transport {
  const answer = (a: TapeAnswer): unknown => {
    if ("error" in a) throw new TransportError(a.error);
    if ("refused" in a) throw new Error(a.refused);
    return a.result;
  };
  return {
    trust: inner.trust,
    label: inner.label,
    rpc: async (m, p) => {
      if (m === "state_getStorage" && p[0] === UPGRADE_KEYS.lastRuntimeUpgrade) return answer(answers.lastRuntimeUpgrade);
      if (m === "state_getStorage" && p[0] === UPGRADE_KEYS.authorizedUpgrade) return answer(answers.authorizedUpgrade);
      return inner.rpc(m, p);
    },
    httpGet: (u) => inner.httpGet(u),
    now: () => inner.now(),
    close: () => inner.close(),
  };
}

/** The transport with the upgrade watch answered for a real tape that holds neither read (UPGRADE_ANSWERS), and any other as it is. */
export function upgradeAs(dir: string, inner: Transport): Transport {
  const answers = UPGRADE_ANSWERS[dir];
  return answers === undefined ? inner : answeringUpgrade(inner, answers);
}

/**
 * The transport with the anchor answered as the fixture's own chain would answer it (ANCHOR_ANSWERS),
 * and, for a real tape, the upgrade watch too (UPGRADE_ANSWERS).
 */
export function anchoredAs(dir: string, inner: Transport): Transport {
  const answer = ANCHOR_ANSWERS[dir];
  if (answer === undefined) throw new Error(`no anchor answer is written down for ${dir}`);
  return answeringAnchor(upgradeAs(dir, inner), answer);
}
