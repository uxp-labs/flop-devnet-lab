// A module resolve hook for scripts that run the tests' TypeScript helpers under Node's own type
// stripping (Node 22.18 and later): src and test modules import their siblings as .js, which tsc
// writes and vitest maps, so a relative .js import from a .ts module is resolved to the .ts file
// beside it when that file exists. Nothing else is changed. Used by scripts/write-requests.mjs only.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  if (parent.endsWith(".ts") && specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const ts = new URL(`${specifier.slice(0, -3)}.ts`, parent);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
}
