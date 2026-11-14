/**
 * The mortal era of the chain encoder (rule E7). Always mortal, always a period of 64 blocks: an immortal
 * transaction can be replayed for ever, and this is a spend path. There is no immortal era here.
 *
 * The encoding is Substrate's Era::Mortal(period, phase), two bytes little endian: the low 4 bits hold
 * log2(period) - 1, the high 12 bits the phase (period 64 needs no quantizing). The phase is the birth
 * block's number modulo the period. The chain checks the hash of the birth block, and takes the
 * transaction in a block from the birth to the birth plus 63.
 */
import { refuse } from "./errors.js";
import { ByteReader, uintLE } from "./scale.js";
import { freezeFunction } from "../freeze.js";

export const ERA_PERIOD = 64;
const LOG2_PERIOD = 6;
const U32_MAX = 2 ** 32 - 1;

function checkBirth(birth: number): void {
  if (!Number.isSafeInteger(birth) || birth < 0 || birth > U32_MAX) refuse("OUT_OF_RANGE", `a birth block number is a u32, not ${String(birth)}`);
  if (birth + ERA_PERIOD - 1 > U32_MAX) refuse("OUT_OF_RANGE", `a transaction born at ${birth} would outlive the u32 block numbers`);
}

/** The last block at which a transaction born at `birth` is valid. */
export function lastValidBlock(birth: number): number {
  checkBirth(birth);
  return birth + ERA_PERIOD - 1;
}
freezeFunction(lastValidBlock);

/** The two era bytes of a transaction born at block `birth`. */
export function mortalEra(birth: number): Uint8Array {
  checkBirth(birth);
  const phase = birth % ERA_PERIOD;
  return uintLE(BigInt((LOG2_PERIOD - 1) | (phase << 4)), 2);
}
freezeFunction(mortalEra);

/** Reads an era and refuses any but a mortal one of period 64. Returns its phase. */
export function readEra(r: ByteReader): { period: number; phase: number } {
  const first = r.byte();
  if (first === 0) refuse("BAD_BYTES", "an immortal era: the encoder writes only mortal eras");
  const encoded = first | (r.byte() << 8);
  const period = 2 << (encoded % 16);
  const phase = encoded >> 4; // the quantize factor is 1 below a period of 4096
  if (period !== ERA_PERIOD) refuse("BAD_BYTES", `an era of period ${period}: the encoder writes only ${ERA_PERIOD}`);
  if (phase >= period) refuse("BAD_BYTES", `an era phase ${phase} not below its period`);
  return { period, phase };
}
freezeFunction(readEra);
