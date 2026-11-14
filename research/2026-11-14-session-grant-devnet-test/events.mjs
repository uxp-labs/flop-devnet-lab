// The events of one extrinsic as the lab's own decoder gives them (H14): the tool's readBlockEvents
// over a block tape decodes the block's System.Events through chain-read's door; this file takes the
// events of the extrinsic at its index, in the record's form of the rerun (results.json events_form:
// { pallet, name, fields }, every { variant, fields } written { type, value }, as
// imd-flop/test/chain-read-replay.test.ts recordForm writes it), its outcome and its fee. Pure.

/** A decoded value in the record's form. */
export function recordFormOf(v) {
  if (Array.isArray(v)) return v.map(recordFormOf);
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("variant") && keys.includes("fields") && typeof v.variant === "string") return { type: v.variant, value: recordFormOf(v.fields) };
    return Object.fromEntries(keys.map((k) => [k, recordFormOf(v[k])]));
  }
  return v;
}

/** The events of the extrinsic at an index of a readBlockEvents value, in the record's form. */
export const extrinsicEvents = (blockEvents, index) =>
  (blockEvents?.events ?? [])
    .filter((e) => e.phase?.variant === "ApplyExtrinsic" && e.phase.fields === index)
    .map((e) => ({ pallet: e.pallet, name: e.event, fields: recordFormOf(e.fields) }));

/**
 * The outcome of an extrinsic by its events: success true with System.ExtrinsicSuccess, false with
 * System.ExtrinsicFailed and the error its dispatch_error names (pallet index, the first byte of the
 * error bytes, and the name errors-1014020.json gives it, or null), null when neither or both.
 */
export function outcomeOf(events, errors) {
  const ok = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicSuccess");
  const failed = events.filter((e) => e.pallet === "System" && e.name === "ExtrinsicFailed");
  if (ok.length + failed.length !== 1) return { success: null, error: null };
  if (ok.length) return { success: true, error: null };
  const d = failed[0].fields?.dispatch_error;
  if (d?.type !== "Module" || !Number.isInteger(d.value?.index) || !/^0x[0-9a-f]{8}$/.test(d.value?.error ?? "")) return { success: false, error: { pallet_index: null, error_index: null, name: null, dispatch_error: d ?? null } };
  const pallet_index = d.value.index, error_index = parseInt(d.value.error.slice(2, 4), 16);
  const named = errors.errors.find((x) => x.pallet_index === pallet_index && x.error_index === error_index);
  return { success: false, error: { pallet_index, error_index, name: named ? `${named.pallet}.${named.name}` : null } };
}

/** The fee of an extrinsic: actual_fee of its one TransactionPayment.TransactionFeePaid, paid by the payer; null when not exactly one. */
export function feeOf(events, payer) {
  const paid = events.filter((e) => e.pallet === "TransactionPayment" && e.name === "TransactionFeePaid");
  if (paid.length !== 1 || paid[0].fields?.who !== payer || typeof paid[0].fields?.actual_fee !== "string") return null;
  return paid[0].fields.actual_fee;
}

/** The decoder's reading of a step from the tool's block output: its events, outcome and fee, or null when the tool did not read the block. */
export function decoderReading(output, index, errors, payer) {
  if (output?.exit !== 0 || !Number.isInteger(index)) return null;
  const events = extrinsicEvents(output.json, index);
  return { extrinsic_index: index, events, names: events.map((e) => `${e.pallet}.${e.name}`), ...outcomeOf(events, errors), fee_raw: feeOf(events, payer) };
}
