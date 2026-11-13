/**
 * The one file of imd-flop that reads a shape file of the observatory (P2, rule A4). It finds the file through the
 * package, flop-observatory/shapes/<name>.json, never by a relative path into ../observatory. Not pure: it reads a
 * file. A name that is not a shape file's, a file that cannot be found or read, and one past the cap are unknown.
 */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { type Got, known, unknown } from "./result.js";

/** A shape file's path in the observatory package, as the reviewed line names it. */
const SHAPE_FILE = /^shapes\/[a-z0-9][a-z0-9.-]*\.json$/;

/** The largest shape file read, in bytes: the decoder refuses a longer one (its MAX_INPUT_BYTES, 16 MiB). */
export const SHAPE_FILE_CAP = 16 * 1024 * 1024;

const require = createRequire(import.meta.url);

/** The text of the shape file a reviewed line names (Runtime.shapeFile). */
export function shapeFileText(shapeFile: string): Got<string> {
  if (!SHAPE_FILE.test(shapeFile)) return unknown(`${JSON.stringify(shapeFile.slice(0, 80))} is not the name of a shape file`);
  let path: string;
  try {
    path = require.resolve(`flop-observatory/${shapeFile}`);
  } catch {
    return unknown(`the package flop-observatory holds no ${shapeFile}`);
  }
  try {
    if (statSync(path).size > SHAPE_FILE_CAP) return unknown(`${shapeFile} is more than ${SHAPE_FILE_CAP} bytes`);
    return known(readFileSync(path, "utf8"));
  } catch {
    return unknown(`${shapeFile} could not be read`);
  }
}
