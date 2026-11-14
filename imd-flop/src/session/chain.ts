/**
 * What the session commands ask the chain (P5b, rules C5 to C8), through chain-read only. Nothing here can send:
 * chain-read's transport allows its five read methods alone.
 *
 *  - C5: one transport, the caller's when it hands one in, else nodeTransport of the network's rpc.
 *  - C6: the node is held to the network first. The hash at height 0, read through chain-read's blockHash, must
 *    equal the network's pinned genesis. Unknown is exit 1; another hash is refused with exit 5.
 *  - C7: the session's state from readSessionState at the finalized head. An unknown read is exit 1 with its reason.
 *  - C8: the encoder's runtime from the spec name and version the read names and the network's genesis, through
 *    runtimeIdOf, with the runtime's two constants. A runtime not in the encoder's table is unknown here; each
 *    command decides what that means for it.
 */
import { ChainEncodeError } from "../chain/errors.js";
import { sessionConstants, type SessionConstants } from "../chain/owner-calls.js";
import { runtimeIdOf, type RuntimeId } from "../chain/table.js";
import { blockHash, nodeTransport, type Transport } from "../chain-read/node.js";
import { readSessionState, type SessionState } from "../chain-read/read.js";
import { known, unknown, type Got } from "../chain-read/result.js";
import { CliError, EXIT } from "../errors.js";
import type { NetworkInfo } from "../networks.js";
import type { Account } from "./accounts.js";

/** The transport of rule C5. */
export const transportOf = (net: NetworkInfo, given: Transport | undefined): Transport => given ?? nodeTransport(net.rpc);

/** Rule C6: the node's block 0 is the network's pinned genesis. */
export async function holdGenesis(t: Transport, net: NetworkInfo): Promise<void> {
  const g = await blockHash(t, 0);
  if (g.kind === "unknown") throw new CliError(`the node's block 0 cannot be read, so the node is not known to be ${net.name}: ${g.reason}`, EXIT.ERROR);
  if (g.value !== net.genesisHash) throw new CliError(`the node's block 0 is ${g.value}, not ${net.name}'s pinned genesis ${net.genesisHash}: another chain or a reset. Refused, nothing printed`, EXIT.REFUSED_RULE);
}

/** Rule C7: the state at the finalized head, or exit 1 with the read's own reason. */
export async function stateOf(t: Transport, owner: Account, device: Account): Promise<SessionState> {
  const r = await readSessionState(t, owner.hex, device.hex);
  if (r.kind === "unknown") throw new CliError(`the session's state is unknown: ${r.reason}`, EXIT.ERROR);
  return r.value;
}

/** The encoder's runtime and its constants. */
export interface EncoderRuntime {
  readonly id: RuntimeId;
  readonly constants: SessionConstants;
}

/** The runtime name a read gives, for words. */
export const specText = (s: SessionState): string => `${s.runtime.specName} ${s.runtime.specVersion}`;

/** Rule C8: the encoder's runtime for the read's spec, or unknown with the words that name the spec. */
export function encoderRuntime(s: SessionState, net: NetworkInfo): Got<EncoderRuntime> {
  try {
    const id = runtimeIdOf({ specName: s.runtime.specName, specVersion: s.runtime.specVersion, genesisHash: net.genesisHash });
    return known(Object.freeze({ id, constants: sessionConstants(id) }));
  } catch (e) {
    if (e instanceof ChainEncodeError) return unknown(`the runtime at the head, ${specText(s)}, is not in the encoder's table: ${e.message}`);
    throw e;
  }
}

/** Rule C8 for grant and revoke: a runtime not in the encoder's table is refused with exit 5. */
export function requireEncoderRuntime(s: SessionState, net: NetworkInfo): EncoderRuntime {
  const r = encoderRuntime(s, net);
  if (r.kind === "unknown") throw new CliError(`${r.reason}. Refused, no call printed`, EXIT.REFUSED_RULE);
  return r.value;
}
