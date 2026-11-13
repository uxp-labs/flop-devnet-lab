// The shape file of a reviewed line, derived again: the line found in REVIEWED by its spec version,
// its metadata found on the third recording's tape by the sha256 the line names, deriveShape over
// it, written by shapeText. The one place scripts/write-shape.mjs and the tests get it from. Pure
// but for reading the committed files it names, and, in writeShapeMain with --write, the one file
// it is asked to write.
import { readFileSync, writeFileSync } from "node:fs";
import { parseMetadata } from "../../src/scale/metadata.js";
import { REVIEWED, SHAPE_SCHEMA, deriveShape, schemaNamed, shapeText } from "../../src/scale/shape.js";
import { reviewedMetadata } from "./recorded-upgrade.js";

const PKG = new URL("../../", import.meta.url);

/** The reviewed line's shape file, by its path in the package, and the text deriveShape gives for it. */
export function derivedShapeFile(spec: number): { file: string; text: string } {
  const line = REVIEWED.find((r) => r.specVersion === spec);
  if (line === undefined) throw new Error(`no reviewed line names spec ${spec}`);
  return { file: line.shapeFile, text: shapeText(deriveShape(parseMetadata(reviewedMetadata(spec)))) };
}

export interface ShapeFileIo {
  read: (file: string) => string;
  write: (file: string, text: string) => void;
}

const fileIo: ShapeFileIo = {
  read: (file) => readFileSync(new URL(file, PKG), "utf8"),
  write: (file, text) => writeFileSync(new URL(file, PKG), text),
};

export const USAGE = "usage: node scripts/write-shape.mjs --spec <reviewed spec version> [--write]";

/**
 * The command. Without --write it compares the committed file with the derived text: exit 0 when
 * they are the same bytes, 1 when not (or when the file cannot be read). With --write it writes the
 * derived text to the line's file and exits 0. A committed file of another shape format is named
 * so, with both formats. A call it does not understand, or a spec no
 * reviewed line names, is exit 2 with one line on stderr.
 */
export function writeShapeMain(args: readonly string[], io: ShapeFileIo = fileIo): { code: number; stdout: string; stderr: string } {
  const write = args.length === 3 && args[2] === "--write";
  if (!(args.length === 2 || write) || args[0] !== "--spec" || !/^[0-9]+$/.test(args[1] ?? "")) return { code: 2, stdout: "", stderr: `${USAGE}\n` };
  const spec = Number(args[1]);
  if (!REVIEWED.some((r) => r.specVersion === spec)) return { code: 2, stdout: "", stderr: `write-shape refused: no reviewed line names spec ${spec}\n` };
  const { file, text } = derivedShapeFile(spec);
  if (write) {
    io.write(file, text);
    return { code: 0, stdout: `wrote ${file}, the shape derived from the reviewed metadata of spec ${spec}\n`, stderr: "" };
  }
  let committed: string | null;
  try {
    committed = io.read(file);
  } catch {
    committed = null;
  }
  if (committed === text) return { code: 0, stdout: `${file} is the shape derived from the reviewed metadata of spec ${spec}\n`, stderr: "" };
  if (committed === null) return { code: 1, stdout: `${file} cannot be read; spec ${spec}\n`, stderr: "" };
  const named = schemaNamed(committed);
  const format = named !== null && named !== SHAPE_SCHEMA ? `: it is ${named}, not ${SHAPE_SCHEMA}` : "";
  return { code: 1, stdout: `${file} differs from the shape derived from the reviewed metadata of spec ${spec}${format}\n`, stderr: "" };
}
