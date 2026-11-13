// The shape writer (scripts/write-shape.mjs, through writeShapeMain in test/helpers/shape-file.ts,
// round 29): it derives a reviewed line's shape file from the metadata the third recording holds by
// the line's sha256, writes it only when asked, and otherwise compares it with the committed file.
import { describe, expect, it } from "vitest";
import { REVIEWED } from "../src/scale/shape.js";
import { USAGE, derivedShapeFile, writeShapeMain } from "./helpers/shape-file.js";

/** Files in memory: what was read and what was written, by path. */
const memory = (files: Record<string, string>) => {
  const written: Record<string, string> = {};
  return {
    written,
    io: {
      read: (f: string) => {
        const t = files[f];
        if (t === undefined) throw new Error("ENOENT");
        return t;
      },
      write: (f: string, t: string) => {
        written[f] = t;
      },
      derive: derivedShapeFile,
    },
  };
};

describe("the shape writer", () => {
  const OLD = REVIEWED[0];
  if (OLD === undefined) throw new Error("no reviewed line");
  const derived = derivedShapeFile(OLD.specVersion);

  it("derives a line's file under the path the line names", () => {
    expect(derived.file).toBe(OLD.shapeFile);
    expect(derived.text.endsWith("}\n")).toBe(true);
  });

  it("compares without --write: exit 0 for the same bytes, 1 for a file one byte off or one it cannot read, and writes nothing", () => {
    const same = memory({ [OLD.shapeFile]: derived.text });
    expect(writeShapeMain(["--spec", String(OLD.specVersion)], same.io)).toEqual({ code: 0, stdout: `${OLD.shapeFile} is the shape derived from the reviewed metadata of spec ${OLD.specVersion}\n`, stderr: "" });
    const off = memory({ [OLD.shapeFile]: `${derived.text} ` });
    expect(writeShapeMain(["--spec", String(OLD.specVersion)], off.io)).toEqual({ code: 1, stdout: `${OLD.shapeFile} differs from the shape derived from the reviewed metadata of spec ${OLD.specVersion}\n`, stderr: "" });
    const none = memory({});
    expect(writeShapeMain(["--spec", String(OLD.specVersion)], none.io)).toMatchObject({ code: 1, stdout: `${OLD.shapeFile} cannot be read; spec ${OLD.specVersion}\n` });
    expect([same.written, off.written, none.written]).toEqual([{}, {}, {}]);
  });

  it("writes the derived text to the line's file only with --write", () => {
    const m = memory({ [OLD.shapeFile]: "old" });
    expect(writeShapeMain(["--spec", String(OLD.specVersion), "--write"], m.io)).toMatchObject({ code: 0, stderr: "" });
    expect(m.written).toEqual({ [OLD.shapeFile]: derived.text });
  });

  it("refuses with exit 2 and one line a call it does not understand, and a spec no reviewed line names", () => {
    const m = memory({});
    for (const args of [[], ["--spec"], ["--spec", "x"], ["--spec", "01014014"], ["--spec", "01014014", "--write"], ["--spec", "1014014", "--force"], ["--write", "--spec", "1014014"], ["--spec", "1014014", "--write", "--write"]]) {
      expect(writeShapeMain(args, m.io), args.join(" ")).toEqual({ code: 2, stdout: "", stderr: `${USAGE}\n` });
    }
    expect(writeShapeMain(["--spec", "1014015", "--write"], m.io)).toEqual({ code: 2, stdout: "", stderr: "write-shape refused: no reviewed line names spec 1014015\n" });
    expect(m.written).toEqual({});
  });

  it("refuses in one line when the metadata cannot be derived, with or without --write, and writes nothing", () => {
    const m = memory({ [OLD.shapeFile]: derived.text });
    const io = {
      ...m.io,
      derive: () => {
        throw new Error("the tape does not hold the metadata");
      },
    };
    for (const args of [["--spec", String(OLD.specVersion)], ["--spec", String(OLD.specVersion), "--write"]]) {
      expect(writeShapeMain(args, io), args.join(" ")).toEqual({ code: 2, stdout: "", stderr: "write-shape refused: the tape does not hold the metadata\n" });
    }
    expect(m.written).toEqual({});
  });
});
