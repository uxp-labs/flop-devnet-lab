// The one way real chain data is decoded (RULES.md section 9): a block's System.Events, decoded only
// when the shape pin (src/scale/shape.ts) says the block's spec, metadata and shape are the reviewed
// ones. Pure: no file, network, clock or random access.
import { type BlockEvent, decodeEvents } from "./events.js";
import { ScaleError } from "./reader.js";
import { type PinInput, type ReviewedShape, pinShape } from "./shape.js";

export type BlockEvents = { decoded: true; reviewed: ReviewedShape; events: BlockEvent[] } | { decoded: false; refused: string };

/** The events of one block, or the reason they were not decoded: the pin's refusal, or the decoder's. */
export function decodeBlockEvents(input: PinInput & { events: Uint8Array }): BlockEvents {
  const pin = pinShape(input);
  if (!pin.pinned) return { decoded: false, refused: `not decoded: ${pin.refused}` };
  try {
    return { decoded: true, reviewed: pin.reviewed, events: decodeEvents(pin.metadata, input.events) };
  } catch (e) {
    if (e instanceof ScaleError) return { decoded: false, refused: `System.Events: ${e.message}` };
    throw e;
  }
}
