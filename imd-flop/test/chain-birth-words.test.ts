/**
 * K2: the era line claims no more than the bytes and the signature hold. Two birth numbers 64 apart with the
 * same hash have the same phase, so both read back and both sign. The words of each say the number is as
 * given and that the bytes hold only the phase. The key is made in the test and never written.
 */
import { describe, expect, it } from "vitest";
import { describeExtrinsic } from "../src/chain/describe.js";
import { signSessionCall } from "../src/chain/extrinsic.js";
import { readExtrinsic } from "../src/chain/reader.js";
import { hex, OWNER, RUNTIME_ID, sampleInner, testDevice, unhex } from "./lib/chain-fixtures.js";

const HASH = unhex("0xa85d1dcb67ae73c8c910634c75c043e62f83cf06dd4a90bbb5abe19c8674d08e");

describe("K2: birth block words", () => {
  for (const number of [3584700, 3584700 + 64]) {
    it(`birth ${number}: reads back, signs, and the words say the number is as given`, () => {
      const device = testDevice();
      const birth = { number, hash: HASH };
      const out = signSessionCall({ runtime: RUNTIME_ID, owner: OWNER, inner: sampleInner().timeout, sessionNonce: 0n, accountNonce: 0, birth, signer: { publicKey: device.publicKey, sign: device.sign } });
      expect(readExtrinsic(RUNTIME_ID, out.extrinsic, birth).birth.number).toBe(number);
      for (const words of [out.description, describeExtrinsic(RUNTIME_ID, out.extrinsic, birth)]) {
        const era = words.split("\n").filter((l) => l.startsWith("mortal era"));
        expect(era).toHaveLength(1);
        expect(era[0]).toContain(`the signature binds the birth block hash ${hex(HASH)}`);
        expect(era[0]).toContain(`the birth block number ${number} is as given, the bytes hold only the phase`);
        expect(era[0]).toContain(`the last valid block ${number + 63} follows from that number`);
      }
    });
  }
});
