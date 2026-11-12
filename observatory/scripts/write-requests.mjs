#!/usr/bin/env node
// Writes the request list: recordings/requests.json derived from recordings/requests-inputs.json and
// the first recording's metadata, through the same function the tests hold the committed file to
// (requestsListText in test/helpers/requests-list.ts). It reads no network and writes one file.
//
//   node scripts/write-requests.mjs --out recordings/requests.json
//
// test/storage-requests.test.ts holds the committed file to that function, and scripts/cli-checks.mjs
// runs this script into a temporary folder and compares the bytes.
import { writeFileSync } from "node:fs";
import { register } from "node:module";

// Node's own type stripping runs the tests' TypeScript helpers: Node 22.18 and later, as
// package.json's engines says. On an older Node this says so in one line of its own, and exits 1.
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 18)) || !process.features.typescript) {
  process.stderr.write(`write-requests needs Node 22.18 or later, with type stripping; this is Node ${process.versions.node}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || args[1] === "" || args[1].startsWith("--")) {
  process.stderr.write("usage: node scripts/write-requests.mjs --out <file>\n");
  process.exit(2);
}
register(new URL("./ts-resolve.mjs", import.meta.url));
const { requestsListText } = await import("../test/helpers/requests-list.ts");
writeFileSync(args[1], requestsListText());
