/**
 * The three session commands (P5b, rule C1): `session grant`, `session revoke` and `session show`. One entry point
 * for the CLI's one case. Each prints to stdout only (the lead's G-16), in words or with `--json` as JSON, and signs,
 * sends and writes nothing.
 */
import { CliError, EXIT } from "../errors.js";
import type { SessionContext } from "./context.js";
import { grant } from "./grant.js";
import { revoke } from "./revoke.js";
import { show } from "./show.js";
import type { Output } from "./words.js";

export type { SessionContext } from "./context.js";

const COMMANDS: Readonly<Record<string, (ctx: SessionContext) => Promise<Output>>> = Object.freeze({ grant, revoke, show });

export const SESSION_USAGE = "usage: session grant --owner <ss58> --days <1..10> | session revoke --owner <ss58> | session show --owner <ss58>";

/** Runs one session command and prints what it gives. Returns the exit code; a refusal is a CliError, which the CLI prints. */
export async function sessionCommand(sub: string | undefined, ctx: SessionContext, out: (s: string) => void, json: boolean): Promise<number> {
  const run = sub !== undefined && Object.hasOwn(COMMANDS, sub) ? COMMANDS[sub] : undefined;
  if (run === undefined) throw new CliError(SESSION_USAGE, EXIT.USAGE);
  const o = await run(ctx);
  if (json) out(JSON.stringify(o.json, null, 2));
  else for (const l of o.lines) out(l);
  return o.code;
}
