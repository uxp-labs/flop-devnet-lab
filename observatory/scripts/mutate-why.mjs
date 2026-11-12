// What scripts/mutate.mjs writes to stderr when its result is not a pass (review round 28, N2):
// the check's own log then says why the mutants step failed, even where its evidence folder cannot
// be read. Its stdout document does not change. At most WHY_LINES lines, each cut at WHY_WIDTH
// characters: the summary, both controls with the first failing test of a failed control, and the
// id of every mutant that was not killed with its outcome, as many as fit, then how many more.

export const WHY_LINES = 20;
export const WHY_WIDTH = 300;

/**
 * A failed control's first failing test as text: its file, its name and its first failure, or
 * what kept the control from naming one.
 * @param {{ exit: number | null, timeout?: boolean, noReport?: boolean, tail: string }} run
 * @param {{ file: string, failed: string[], firstFailure: string, message: string }[]} failing
 * @param {string[]} missing
 * @returns {string}
 */
export function firstFailingOf(run, failing, missing) {
  const f = failing[0];
  if (f !== undefined) return `${f.file} > ${f.failed[0] ?? "no test failed in the file"}: ${f.firstFailure || f.message}`;
  if (run.timeout) return "none: the run timed out";
  if (run.noReport) return `none: no report (${run.tail.split("\n").filter(Boolean).at(-1) ?? ""})`;
  if (missing.length > 0) return `none: ${missing[0]} did not run`;
  return `none: exit ${run.exit}`;
}

const cut = (s) => (s.length > WHY_WIDTH ? s.slice(0, WHY_WIDTH) : s);

/**
 * The lines, from mutate.mjs's stdout document and, for each control that failed, its first
 * failing test as text.
 * @param {{ summary: Record<string, unknown>, control_before: { outcome: string } | null, control_after: { outcome: string } | null, results: { id: string | null, outcome: string }[] }} doc
 * @param {{ before?: string, after?: string }} [firstFailing]
 * @returns {string[]}
 */
export function whyNotPass(doc, firstFailing = {}) {
  const s = doc.summary;
  const control = (name, c, first) => {
    const outcome = c?.outcome ?? "not-run";
    return outcome === "control-fail" ? `${name}: control-fail, first failing test: ${first ?? "none named"}` : `${name}: ${outcome}`;
  };
  const head = [
    `mutants not a pass: ${s.mutants} mutants, ${s.killed} killed, ${s.survived} survived, ${s.load_error} load errors, ${s.invalid} invalid, ${s.other} other, ${s.setup}`,
    control("control before", doc.control_before, firstFailing.before),
    control("control after", doc.control_after, firstFailing.after),
  ];
  const notKilled = doc.results.filter((r) => r.outcome !== "killed").map((r) => `not killed: ${r.id ?? "(no id)"} ${r.outcome}`);
  const room = WHY_LINES - head.length;
  const shown = notKilled.length <= room ? notKilled : [...notKilled.slice(0, room - 1), `and ${notKilled.length - (room - 1)} more not killed`];
  return [...head, ...shown].map(cut);
}
