// explorer-reader.js: paste into a tab on FLOP's explorer's own origin,
// https://explorer.devnet.flop.network/ (the browser pane). No import, no library. GET only, to the
// one host below (steps.json EXPLORER, held equal by a test) (E1). It reads one extrinsic:
//   read(extrinsicHash)   GET /api/transactions/<extrinsic hash>
// and returns found, not-found (the explorer's 404) or failed with the HTTP status (E2). For found it
// gives the exact text to relay to the PC (relay) and that text's sha256 (relay_sha256): one JSON
// object with source, read_utc, hash, block_hash, success, error (null, or { index, error } as
// numbers from the last system.ExtrinsicFailed), failed_data (that event's dispatchError unchanged,
// or null), names (every event as section.method, in order) and events (only those of
// computeChannel and flopSessionKeys, each { section, method, data } unchanged). It interprets
// nothing else. The PC refuses a reading whose success does not agree with the one
// system.ExtrinsicSuccess or system.ExtrinsicFailed among its names, and an error that is not the
// one failed_data gives (F2).
// The request follows no redirect (redirect: "error"), and an answer whose url is not the address
// asked for is failed (F9). The answer's shape is the one the lead read on 2026-11-13
// (lead-measurements-2026-11-13.json measurements.explorer_answer_shape).
//
// Use, in the page's console:
//   const explorer = explorerReader.createReader();
//   window.__e = explorer.read("<extrinsic hash>");
//   (await window.__e).relay            and   (await window.__e).relay_sha256
(function (root) {
  "use strict";

  var EXPLORER = "https://explorer.devnet.flop.network";
  var KEPT = ["computeChannel", "flopSessionKeys"];
  var HASH = /^0x[0-9a-f]{64}$/;
  var DIGITS = "0123456789abcdef";

  function hexOfBuffer(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }
  function sha256Hex(text) {
    return root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(hexOfBuffer);
  }

  /** { index, error } as numbers from a dispatchError of the shape {"Module":{"index":"94","error":"0x14000000"}}; else null fields. */
  function moduleError(d) {
    var m = d && typeof d === "object" ? d.Module : null;
    if (!m || typeof m !== "object") return { index: null, error: null };
    var index = typeof m.index === "string" && /^[0-9]+$/.test(m.index) ? Number(m.index) : typeof m.index === "number" ? m.index : null;
    var e = typeof m.error === "string" && /^0x[0-9a-f]{8}$/.test(m.error) ? DIGITS.indexOf(m.error[2]) * 16 + DIGITS.indexOf(m.error[3]) : null;
    return { index: index, error: e };
  }

  function createReader(opts) {
    opts = opts || {};
    var get = opts.fetch || function (url, init) { return root.fetch(url, init); };
    var INIT = { method: "GET", credentials: "omit", redirect: "error" };
    var nowIso = opts.nowIso || function () { return new Date().toISOString(); };

    function read(extrinsicHash) {
      if (typeof extrinsicHash !== "string" || !HASH.test(extrinsicHash)) return Promise.resolve({ status: "failed", http_status: null, problem: "the extrinsic hash must be 0x and 64 lower case hex digits" });
      var path = "/api/transactions/" + extrinsicHash;
      var asked = EXPLORER + path;
      return get(asked, INIT).then(function (res) {
        if (!res || res.url !== asked) return { status: "failed", http_status: res && typeof res.status === "number" ? res.status : null, hash: extrinsicHash, problem: "the answer's url is " + (res ? res.url : "missing") + ", not the address asked for" };
        if (res.status === 404) return { status: "not-found", http_status: 404, hash: extrinsicHash };
        if (res.status !== 200) return { status: "failed", http_status: res.status, hash: extrinsicHash };
        return res.json().then(function (a) {
          var shaped = a && typeof a === "object" && a.hash === extrinsicHash && typeof a.blockHash === "string" && HASH.test(a.blockHash) && typeof a.success === "boolean" && Array.isArray(a.events) &&
            a.events.every(function (e) { return e && typeof e.section === "string" && typeof e.method === "string"; });
          if (!shaped) return { status: "failed", http_status: 200, hash: extrinsicHash, problem: "the answer is not of the shape the lead read" };
          var failed = null;
          for (var i = 0; i < a.events.length; i++) if (a.events[i].section === "system" && a.events[i].method === "ExtrinsicFailed") failed = a.events[i];
          var value = {
            source: EXPLORER + path, read_utc: nowIso(),
            hash: a.hash, block_hash: a.blockHash, success: a.success,
            error: failed ? moduleError(failed.data && failed.data.dispatchError) : null,
            failed_data: failed ? (failed.data && failed.data.dispatchError !== undefined ? failed.data.dispatchError : null) : null,
            names: a.events.map(function (e) { return e.section + "." + e.method; }),
            events: a.events.filter(function (e) { return KEPT.indexOf(e.section) >= 0; }).map(function (e) { return { section: e.section, method: e.method, data: e.data }; }),
          };
          var text = JSON.stringify(value);
          return sha256Hex(text).then(function (sha) { return { status: "found", value: value, relay: text, relay_sha256: sha }; });
        }, function () { return { status: "failed", http_status: 200, hash: extrinsicHash, problem: "the answer is not JSON" }; });
      }, function (e) { return { status: "failed", http_status: null, hash: extrinsicHash, problem: String(e && e.message ? e.message : e) }; });
    }

    return { read: read };
  }

  root.explorerReader = { createReader: createReader, EXPLORER: EXPLORER };
})(globalThis);
