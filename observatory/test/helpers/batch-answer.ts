// The reader of one state_queryStorageAt answer (RULES.md section 8, review round 24, L4). It
// refuses, never guesses: the answer must be exactly one set, for exactly the block asked, listing
// every key asked once and no other, each value bytes as 0x hex or null. A key listed with null
// holds nothing. Anything else is a refused read, and every value of that block stays unknown.
// Pure: it reads no file and decodes nothing; what the bytes mean is the decoder's
// (src/scale/block.ts), and it imports nothing of src.

export type BatchAnswer = { read: true; values: Map<string, Uint8Array | null> } | { read: false; refused: string };

const HEX = /^0x(?:[0-9a-f]{2})*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The values of one batch answer by the key asked, or why the answer was refused. */
export function readBatchAnswer(result: unknown, asked: readonly string[], blockHash: string): BatchAnswer {
  const refuse = (why: string): BatchAnswer => ({ read: false, refused: `the batch at ${blockHash} is refused: ${why}` });
  if (new Set(asked).size !== asked.length) return refuse("the keys asked hold one twice");
  if (!Array.isArray(result)) return refuse("the answer is not a list of sets");
  if (result.length !== 1) return refuse(`the answer holds ${result.length} sets, not exactly one`);
  const set: unknown = result[0];
  if (!isRecord(set) || Object.keys(set).sort().join(",") !== "block,changes") return refuse("the set must hold exactly block and changes");
  if (set.block !== blockHash) return refuse(`the set is for block ${JSON.stringify(set.block)}, not the block asked`);
  if (!Array.isArray(set.changes)) return refuse("the changes are not a list");
  const wanted = new Set(asked);
  const values = new Map<string, Uint8Array | null>();
  for (const [i, c] of set.changes.entries()) {
    if (!Array.isArray(c) || c.length !== 2) return refuse(`change ${i} is not a pair of a key and a value`);
    const [key, value] = c as [unknown, unknown];
    if (typeof key !== "string" || !wanted.has(key)) return refuse(`change ${i} lists a key not asked`);
    if (values.has(key)) return refuse(`change ${i} lists the key ${key} twice`);
    if (value !== null && (typeof value !== "string" || !HEX.test(value))) return refuse(`change ${i} has a value that is neither 0x hex nor null`);
    values.set(key, value === null ? null : new Uint8Array(Buffer.from(value.slice(2), "hex")));
  }
  for (const k of asked) if (!values.has(k)) return refuse(`the answer lacks the key asked ${k}`);
  return { read: true, values };
}
