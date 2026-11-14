/**
 * P4 review F4 (R2, R3, K18): every function and class that src/channel and src/plain-input.ts export or return is
 * frozen, with its prototype object when it has one; and a function has no own property beyond the ones it is born
 * with, so a property hung on a function before it was frozen is found.
 */
import { describe, expect, it } from "vitest";
import * as auth from "../src/channel/auth.js";
import * as bytes from "../src/channel/bytes.js";
import * as errors from "../src/channel/errors.js";
import * as freeze from "../src/freeze.js";
import * as key from "../src/channel/key.js";
import * as transcript from "../src/channel/transcript.js";
import { plainInput } from "../src/plain-input.js";
import * as plain from "../src/plain-input.js";
import { problems, problemsOf } from "./lib/frozen-walk.js";

describe("F4: what the check finds (control)", () => {
  it("an open function, an open prototype and a property hung on a function", () => {
    function open() {}
    expect(problemsOf(open, "f")).toEqual(["f is not frozen", "f.prototype is not frozen"]);
    function hung() {}
    (hung as unknown as { raw: number }).raw = 1;
    expect(problemsOf(Object.freeze(hung), "f")).toEqual(["f.prototype is not frozen", "f has an own property raw"]);
    const arrow = () => 1;
    (arrow as unknown as { prototype: object }).prototype = Object.freeze({});
    expect(problemsOf(Object.freeze(arrow), "f")).toEqual(["f has an own property prototype"]);
    expect(problemsOf(Object.freeze(() => 1), "f")).toEqual([]);
    expect(problems({ a: { b: () => 1 } }, "x")).toEqual(["x is not frozen", "x.a is not frozen", "x.a.b is not frozen"]);
  });
});

describe("F4: every export is frozen, functions and classes with their prototypes", () => {
  const modules: Record<string, Record<string, unknown>> = { freeze, errors, bytes, transcript, auth, key, "plain-input": plain };
  for (const [name, mod] of Object.entries(modules)) {
    it(`${name}: every export, and what it holds`, () => {
      const open: string[] = [];
      for (const [k, v] of Object.entries(mod)) open.push(...problems(v, `${name}.${k}`));
      expect(open).toEqual([]);
    });
  }

  it("freezeFunction freezes itself and what it is given, a class and its prototype too", () => {
    class C {}
    expect(freeze.freezeFunction(C)).toBe(C);
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen(C.prototype)).toBe(true);
    expect(problemsOf(freeze.freezeFunction, "freezeFunction")).toEqual([]);
  });

  it("what plainInput(refuse) returns: the object and its five functions", () => {
    const p = plainInput(errors.refuse);
    expect(Object.keys(p).sort()).toEqual(["bytesOf", "ownKeys", "ownValue", "takeFields", "uintOf"]);
    expect(problems(p, "plainInput(refuse)")).toEqual([]);
  });

  it("what a key returns: the key and its four functions", () => {
    const k = key.channelKeyFromSeed({ seed: new Uint8Array(32).fill(1) });
    expect(Object.keys(k).sort()).toEqual(["publicKey", "signReceipt", "signRequest", "signTurnAck"]);
    expect(problems(k, "key")).toEqual([]);
  });
});
