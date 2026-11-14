// session-reads.js: paste into the node's tab, https://rpc.devnet.flop.network/ (the browser pane),
// after pane-runner.js, which this file uses for its transport (paneRunner.wsTransport) and its
// sha256 (paneRunner.sha256Hex). pane-runner.js keeps its bytes. No import, no library, no hash of
// its own but sha256: the PC computes every storage key and prints it for the line that calls this.
//
// It reads, and does only this (H4):
//   sessionTape(keys)                 at ONE finalized head, exactly the answers imd-flop's session
//                                     commands ask for (session.ts holdGenesis, then chain-read
//                                     readSessionState), in their order; and, beside the tape, the raw
//                                     values of SessionCount(S) and RotationHistory(S) at the same head
//   blockTape(keys, number, hash)     the answers the tool's readBlockEvents asks for that block, and
//                                     the block 0 hash the PC holds to the plan's genesis
//   probe(back)                       the free read of H7: state_call Core_version 0x at the hash of
//                                     the block `back` below the finalized head; whether the node
//                                     answered and the answer's length, or its refusal
// The metadata answer is large (487100 bytes at 1014020): it is not put in the tape. The pane
// returns its sha256 and its length, and the PC answers that question with the committed bytes of
// the same sha256 only. Each result carries the exact text the lead relays (relay) and that text's
// sha256 (relay_sha256), as pane-runner.js does. A node error on a question is kept in the tape as
// the node's words: the tool then reads that answer as unknown.
//
// Use, in the page's console, after pane-runner.js. A pane call ends after 45 s:
//   const reads = sessionReads.createReader();
//   window.__t = reads.sessionTape({ lru: "0x..", sessions: "0x..", nonces: "0x..", breakers: "0x..", session_count: "0x..", rotation_history: "0x.." });
//   (await window.__t).relay            and   (await window.__t).relay_sha256
(function (root) {
  "use strict";

  var pr = root.paneRunner;
  if (!pr || typeof pr.wsTransport !== "function" || typeof pr.sha256Hex !== "function") throw new Error("session-reads: paste pane-runner.js in this tab first, and check its sha256");

  var HEX = /^0x([0-9a-f]{2})*$/;
  var KEY = /^0x([0-9a-f]{2}){32,}$/;
  var HASH = /^0x[0-9a-f]{64}$/;
  var DIGITS = "0123456789abcdef";
  var SESSION_KEYS = ["lru", "sessions", "nonces", "breakers", "session_count", "rotation_history"];
  var BLOCK_KEYS = ["lru", "events"];

  function nodeWords(e) {
    if (e && typeof e === "object" && ("code" in e || "message" in e)) return { code: e.code === undefined ? null : e.code, message: e.message === undefined ? null : String(e.message) };
    return { code: null, message: String(e) };
  }

  function hexOfBuffer(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  /** The bytes of 0x hex, read digit by digit: no number is decoded. */
  function bytesOfHex(h) {
    var out = new Uint8Array((h.length - 2) / 2);
    for (var i = 0; i < out.length; i++) out[i] = DIGITS.indexOf(h[2 + 2 * i]) * 16 + DIGITS.indexOf(h[3 + 2 * i]);
    return out;
  }

  /** A value with the exact text to relay and that text's sha256 beside it, as pane-runner.js gives them. */
  function withRelay(value) {
    var text = JSON.stringify(value);
    return pr.sha256Hex(text).then(function (sha) {
      var out = Object.assign({}, value);
      out.relay = text;
      out.relay_sha256 = sha;
      return out;
    });
  }

  function checkKeys(keys, names) {
    if (!keys || typeof keys !== "object") throw new Error("session-reads: the keys the PC printed are required");
    var extra = Object.keys(keys).filter(function (k) { return names.indexOf(k) < 0; });
    if (extra.length) throw new Error("session-reads: unknown key " + extra[0] + "; the keys are " + names.join(", "));
    names.forEach(function (k) { if (typeof keys[k] !== "string" || !KEY.test(keys[k])) throw new Error("session-reads: the key " + k + " is not 0x and at least 32 bytes of lower case hex"); });
  }

  function createReader(opts) {
    opts = opts || {};
    var t = opts.transport || pr.wsTransport();
    if (!t || typeof t.request !== "function") throw new Error("session-reads: a transport with request is required");
    var nowIso = opts.nowIso || function () { return new Date().toISOString(); };

    /** One question, its answer or the node's words kept in the tape in the order asked. */
    function ask(tape, method, params) {
      return t.request(method, params).then(function (result) {
        tape.push({ method: method, params: params, result: result === undefined ? null : result });
        return result;
      }, function (e) {
        tape.push({ method: method, params: params, error: nodeWords(e) });
        return undefined;
      });
    }

    /** The metadata at a block: its sha256 and length, never its bytes. */
    function metadataAt(at) {
      return t.request("state_getMetadata", [at]).then(function (h) {
        if (typeof h !== "string" || !HEX.test(h)) return { at: at, sha256: null, length: null, problem: "the answer is not 0x hex" };
        var b = bytesOfHex(h);
        return root.crypto.subtle.digest("SHA-256", b).then(function (d) { return { at: at, sha256: hexOfBuffer(d), length: b.length }; });
      }, function (e) { return { at: at, sha256: null, length: null, node: nodeWords(e) }; });
    }

    /**
     * Block 0, the finalized head and its header: the questions every read starts with. A session
     * read then asks the canonical hash of the head's number (readSessionState, rule X5); a block
     * read does not (readBlockEvents asks the named block's instead).
     */
    function headOf(tape, canonical) {
      var head = { number: null, hash: null, parent: null };
      return ask(tape, "chain_getBlockHash", [0]).then(function () { return ask(tape, "chain_getFinalizedHead", []); }).then(function (h) {
        if (typeof h !== "string" || !HASH.test(h)) return head;
        head.hash = h;
        return ask(tape, "chain_getHeader", [h]).then(function (hdr) {
          if (!hdr || typeof hdr.number !== "string") return head;
          head.number = parseInt(hdr.number, 16);
          head.parent = typeof hdr.parentHash === "string" ? hdr.parentHash : null;
          if (!canonical) return head;
          return ask(tape, "chain_getBlockHash", [head.number]).then(function () { return head; });
        });
      });
    }

    function sessionTape(keys) {
      checkKeys(keys, SESSION_KEYS);
      var tape = [], readUtc = nowIso();
      return headOf(tape, true).then(function (head) {
        if (head.number === null) return withRelay({ kind: "session", read_utc: readUtc, head: { number: null, hash: head.hash }, tape: tape, metadata: null, owner_reads: null });
        return ask(tape, "state_getStorage", [keys.lru, head.hash]).then(function () { return metadataAt(head.parent); }).then(function (md) {
          return ask(tape, "state_getStorage", [keys.sessions, head.hash])
            .then(function () { return ask(tape, "state_getStorage", [keys.nonces, head.hash]); })
            .then(function () { return ask(tape, "state_getStorage", [keys.breakers, head.hash]); })
            .then(function () {
              var side = [];
              return ask(side, "state_getStorage", [keys.session_count, head.hash]).then(function () { return ask(side, "state_getStorage", [keys.rotation_history, head.hash]); }).then(function () {
                return withRelay({ kind: "session", read_utc: readUtc, head: { number: head.number, hash: head.hash }, tape: tape, metadata: md, owner_reads: { session_count: side[0], rotation_history: side[1] } });
              });
            });
        });
      });
    }

    function blockTape(keys, number, hash) {
      checkKeys(keys, BLOCK_KEYS);
      if (!Number.isSafeInteger(number) || number < 0 || typeof hash !== "string" || !HASH.test(hash)) throw new Error("session-reads: blockTape needs the block's number and its 32 byte hash");
      var tape = [], readUtc = nowIso();
      return headOf(tape, false).then(function (head) {
        var out = { kind: "block", read_utc: readUtc, head: { number: head.number, hash: head.hash }, block: { number: number, hash: hash }, tape: tape, metadata: null };
        if (head.number === null) return withRelay(out);
        return ask(tape, "chain_getBlockHash", [number]).then(function () { return ask(tape, "chain_getHeader", [hash]); }).then(function (hdr) {
          var parent = hdr && typeof hdr.parentHash === "string" ? hdr.parentHash : null;
          return ask(tape, "state_getStorage", [keys.lru, hash]).then(function () { return parent === null ? null : metadataAt(parent); }).then(function (md) {
            out.metadata = md;
            return ask(tape, "state_getStorage", [keys.events, hash]).then(function () { return withRelay(out); });
          });
        });
      });
    }

    function probe(back) {
      if (!Number.isSafeInteger(back) || back < 1) throw new Error("session-reads: probe needs how many blocks below the head to read at");
      var tape = [], readUtc = nowIso();
      return headOf(tape, false).then(function (head) {
        var out = { kind: "probe", read_utc: readUtc, head: { number: head.number, hash: head.hash }, at: null, answered: false, length: null, refusal: null };
        if (head.number === null || head.number < back) { out.refusal = { code: null, message: "no finalized head to read below" }; return withRelay(out); }
        return t.request("chain_getBlockHash", [head.number - back]).then(function (at) {
          out.at = { number: head.number - back, hash: at };
          return t.request("state_call", ["Core_version", "0x", at]).then(function (r) {
            out.answered = typeof r === "string" && HEX.test(r);
            out.length = out.answered ? (r.length - 2) / 2 : null;
            if (!out.answered) out.refusal = { code: null, message: "the answer is not 0x hex" };
            return withRelay(out);
          }, function (e) { out.refusal = nodeWords(e); return withRelay(out); });
        }, function (e) { out.refusal = nodeWords(e); return withRelay(out); });
      });
    }

    return { sessionTape: sessionTape, blockTape: blockTape, probe: probe };
  }

  root.sessionReads = { createReader: createReader, SESSION_KEYS: SESSION_KEYS, BLOCK_KEYS: BLOCK_KEYS };
})(globalThis);
