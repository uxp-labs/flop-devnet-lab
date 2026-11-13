// pane-runner.js: paste into a tab on the node's own origin, https://rpc.devnet.flop.network/ (the
// browser pane). No import, no library. It talks JSON-RPC to the one devnet node below and does
// only this:
//   heads()                        the runtime's four names, and the finalized head's number and hash
//   read(keys, blockHash)          the raw stored values of the given keys at that block
//   accountReads(account)          heads() and the account's next nonce: the reads of record-step.mjs start
//   deviceReads(account, key)      heads(), the account's next nonce and the raw value at key: the
//                                  --reads of sign-device.mjs, the session nonce left raw
//   send(bundleText, sha256)       submits the bundle's one signed extrinsic, once, and watches it
//                                  until a final status or the deadline (X1)
//   sendSame(bundleText, sha256)   submits again an extrinsic the sent list holds (X5)
//   find(extrinsicHex, fromNumber) looks for the extrinsic in finalized blocks (X6)
// Every result of send, sendSame and find names its call in sent_by ("send", "sendSame" or "find"),
// also those that submit nothing (H7), so the record knows whether a refusal answered a first send
// or a later sendSame (F3c). find ends within the runner's deadline (H10).
// accountReads, deviceReads, send, sendSame and find return, beside their value, the exact text the
// lead relays to the PC (relay) and that text's sha256 (relay_sha256) (X8). The PC refuses a text
// whose sha256 is not the one given.
// It decodes nothing (X9). It refuses a bundle whose sha256 is not the one given. send never sends
// the same extrinsic twice. An extrinsic the node refuses at submission is reported with the node's
// words and is not retried.
//
// Use, in the page's console. A pane call ends after 45 s and a watch may take up to the deadline
// of 120 s, so keep the promise on window and read it in a second call:
//   const lab = paneRunner.createRunner();
//   window.__r = lab.send('<text of signed/T3.send.json>', "<its sha256>");
//   (await window.__r).relay            and   (await window.__r).relay_sha256
//
// A transport is { request(method, params, onWrite, mayWrite) -> Promise<result>, subscribe(method,
// params, unsubscribeMethod, onNotification, onWrite, mayWrite) -> Promise<{ unsubscribe() }>,
// onLost(fn) }. mayWrite is asked just before the request would be written: when it says no, nothing
// is written and the request rejects with message "call-ended" (F7). onWrite is called only after a
// write to the socket that did not throw; a write that throws rejects with message "write-failed"
// and written false (F8). A node error rejects with { code, message, data }; a lost or never opened
// connection rejects with message "connection-lost" and written true or false.
(function (root) {
  "use strict";

  // The one node and the System.Events key: steps.json RPC and EVENTS_KEY, held equal by a test (X3).
  var RPC = "wss://rpc.devnet.flop.network";
  var EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
  var LOST = "connection-lost";
  var FIND_MAX = 400;

  // The statuses of a watch (X1). A status is a word ("ready") or an object with one key ({ inBlock:
  // hash }). watch: the watch goes on; remember: the block is kept; forget: the kept block is
  // forgotten; final: the extrinsic is in a finalized block, located next; end: the watch ends as
  // "ended" with the node's word. A status not in the table is kept in statuses and never ends the
  // watch. The shapes are Substrate's TransactionStatus as the lead and the reviewer know it
  // (serde, externally tagged, camel case): no committed file of this repo shows them.
  var STATUSES = {
    future: "watch", ready: "watch", broadcast: "watch",
    inBlock: "remember", retracted: "forget",
    finalized: "final",
    usurped: "end", finalityTimeout: "end", dropped: "end", invalid: "end",
  };

  // Every outcome the runner gives; steps.json send_outcomes has a row for each (P2). "ended" has a
  // row for each node word that ends a watch.
  var OUTCOMES = [
    "finalized", "finalized-not-found", "finalized-not-canonical", "finalized-unread",
    "refused-bundle", "already-sent", "not-in-sent-list", "not-sent", "refused-at-submission",
    "deadline", "connection-lost", "ended", "not-found", "find-deadline",
  ];

  var HEX = /^0x([0-9a-f]{2})*$/;
  var HASH = /^0x[0-9a-f]{64}$/;
  var DIGITS = "0123456789abcdef";

  function nodeWords(e) {
    if (e && typeof e === "object" && ("code" in e || "message" in e)) return { code: e.code === undefined ? null : e.code, message: e.message === undefined ? null : String(e.message), data: e.data === undefined ? null : e.data };
    return { code: null, message: String(e), data: null };
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

  function sha256Hex(text) {
    return root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(hexOfBuffer);
  }

  /**
   * The sha256 and length of a System.Events value: the sha256 of its bytes, as the rerun defined
   * events_value_sha256 (research/2026-11-12-session-rerun-1014020/README.md, "How the record was
   * made"; observatory/test/rerun-recording.test.ts sha256 of the value's bytes) (X7).
   */
  function eventsDigest(h) {
    if (typeof h !== "string" || !HEX.test(h)) return Promise.resolve({ events_sha256: null, events_length: null });
    var b = bytesOfHex(h);
    return root.crypto.subtle.digest("SHA-256", b).then(function (d) { return { events_sha256: hexOfBuffer(d), events_length: b.length }; });
  }

  /** The word of a status: the text itself, or the one key of an object; null for any other shape. */
  function wordOf(s) {
    if (typeof s === "string") return s;
    if (s && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 1) return Object.keys(s)[0];
    return null;
  }

  /** Where sent extrinsics are kept: the page's localStorage when there is one, else memory. */
  function defaultStore() {
    var mem = {};
    var ls = null;
    try { ls = root.localStorage || null; } catch (e) { ls = null; }
    return {
      has: function (k) { return ls ? ls.getItem("pane-runner-sent:" + k) !== null : Object.prototype.hasOwnProperty.call(mem, k); },
      add: function (k) { if (ls) ls.setItem("pane-runner-sent:" + k, new Date().toISOString()); else mem[k] = true; },
    };
  }

  /** A JSON-RPC transport over one WebSocket to the one node (X2, X3, X4). */
  function wsTransport(url, WebSocketCtor) {
    if (url !== undefined && url !== RPC) throw new Error("pane-runner: this runner talks only to " + RPC);
    var Ctor = WebSocketCtor || root.WebSocket;
    var ws = new Ctor(RPC);
    var nextId = 1, pending = {}, subs = {}, early = {}, lostFns = [];
    var opened = false, lost = false;
    function lostError(written) { return { code: null, message: LOST, data: null, written: written }; }
    var open = new Promise(function (resolve, reject) {
      ws.onopen = function () { opened = true; resolve(); };
      ws.onerror = function () { if (!opened) { lost = true; reject(lostError(false)); } else lose(); };
      ws.onclose = function () { if (!opened) { lost = true; reject(lostError(false)); } else lose(); };
    });
    open.catch(function () { return null; });
    function lose() {
      if (lost) return;
      lost = true;
      var ids = Object.keys(pending);
      for (var i = 0; i < ids.length; i++) { var p = pending[ids[i]]; delete pending[ids[i]]; p.reject(lostError(true)); }
      for (var j = 0; j < lostFns.length; j++) lostFns[j]();
    }
    ws.onmessage = function (ev) {
      var m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      if (m.id !== undefined && pending[m.id]) {
        var p = pending[m.id]; delete pending[m.id];
        if (m.error) p.reject(m.error); else p.resolve(m.result);
      } else if (m.params && m.params.subscription !== undefined) {
        var s = m.params.subscription;
        if (subs[s]) subs[s](m.params.result); else (early[s] = early[s] || []).push(m.params.result);
      }
    };
    function request(method, params, onWrite, mayWrite) {
      return open.then(function () {
        return new Promise(function (resolve, reject) {
          if (lost || (ws.readyState !== undefined && ws.readyState !== 1)) { reject(lostError(false)); return; }
          if (mayWrite && !mayWrite()) { reject({ code: null, message: "call-ended", data: null, written: false }); return; }
          var id = nextId++;
          pending[id] = { resolve: resolve, reject: reject };
          try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params })); } catch (e) {
            delete pending[id];
            reject({ code: null, message: "write-failed", data: null, written: false });
            return;
          }
          if (onWrite) onWrite();
        });
      });
    }
    function subscribe(method, params, unsubscribeMethod, onNotification, onWrite, mayWrite) {
      return request(method, params, onWrite, mayWrite).then(function (sid) {
        subs[sid] = onNotification;
        (early[sid] || []).forEach(onNotification);
        delete early[sid];
        return { unsubscribe: function () { delete subs[sid]; return request(unsubscribeMethod, [sid]).catch(function () { return null; }); } };
      });
    }
    function onLost(fn) { if (lost && opened) setTimeout(fn, 0); else lostFns.push(fn); }
    return { request: request, subscribe: subscribe, onLost: onLost, close: function () { ws.close(); } };
  }

  /** A value with the exact text to relay and that text's sha256 beside it (X8). */
  function withRelay(value) {
    var text = JSON.stringify(value);
    return sha256Hex(text).then(function (sha) {
      var out = Object.assign({}, value);
      out.relay = text;
      out.relay_sha256 = sha;
      return out;
    });
  }

  function createRunner(opts) {
    opts = opts || {};
    var t = opts.transport || wsTransport();
    if (!t || typeof t.request !== "function" || typeof t.subscribe !== "function") throw new Error("pane-runner: a transport with request and subscribe is required");
    if (opts.eventsKey !== undefined && opts.eventsKey !== EVENTS_KEY) throw new Error("pane-runner: the events key is the constant of this file, " + EVENTS_KEY);
    var deadlineMs = opts.deadlineMs === undefined ? 120000 : opts.deadlineMs;
    var store = opts.store || defaultStore();
    var nowIso = opts.nowIso || function () { return new Date().toISOString(); };
    var lab = { last: null };

    function heads() {
      return t.request("chain_getFinalizedHead", []).then(function (hash) {
        return Promise.all([t.request("chain_getHeader", [hash]), t.request("state_getRuntimeVersion", [hash]), t.request("chain_getBlockHash", [0])]).then(function (r) {
          return {
            runtime: { specName: r[1].specName, specVersion: r[1].specVersion, transactionVersion: r[1].transactionVersion, genesisHash: r[2] },
            finalized: { number: parseInt(r[0].number, 16), hash: hash },
          };
        });
      });
    }

    function read(keys, blockHash) {
      return t.request("state_queryStorageAt", [keys, blockHash]).then(function (sets) {
        var values = {};
        keys.forEach(function (k) { values[k] = undefined; });
        (sets || []).forEach(function (set) { (set.changes || []).forEach(function (c) { if (c[0] in values) values[c[0]] = c[1]; }); });
        var missing = keys.filter(function (k) { return values[k] === undefined; });
        return { block_hash: blockHash, values: values, not_answered: missing };
      });
    }

    function accountReads(account) {
      return heads().then(function (h) {
        return t.request("system_accountNextIndex", [account]).then(function (n) {
          return withRelay({ account: account, runtime: h.runtime, finalized: h.finalized, account_nonce: n });
        });
      });
    }

    function deviceReads(account, sessionNonceKey) {
      return heads().then(function (h) {
        return Promise.all([t.request("system_accountNextIndex", [account]), read([sessionNonceKey], h.finalized.hash)]).then(function (r) {
          if (r[1].not_answered.length) throw new Error("pane-runner: the node did not answer the session nonce key");
          return withRelay({ account: account, runtime: h.runtime, birth: { number: h.finalized.number, hash: h.finalized.hash }, account_nonce: r[0], session_nonce_raw: r[1].values[sessionNonceKey] });
        });
      });
    }

    /** The end of a call: the short value goes out with its relay text; the raw parts stay on lab.last. */
    function finish(value, raw) {
      lab.last = { value: value, events_raw: raw && raw.events_raw !== undefined ? raw.events_raw : null, statuses: raw && raw.statuses ? raw.statuses : [] };
      return withRelay(value);
    }

    /** After a finalized block: where the extrinsic is, and the sha256 and length of its block's events. */
    function locate(xt, blockHash, base, raw) {
      return Promise.all([t.request("chain_getHeader", [blockHash]), t.request("chain_getBlock", [blockHash])]).then(function (r) {
        var number = parseInt(r[0].number, 16);
        var index = r[1].block.extrinsics.indexOf(xt);
        return Promise.all([t.request("chain_getBlockHash", [number]), t.request("state_getStorage", [EVENTS_KEY, blockHash])]).then(function (q) {
          var events = q[1] === undefined ? null : q[1];
          raw.events_raw = events;
          return eventsDigest(events).then(function (d) {
            var out = Object.assign({}, base, { status: "finalized", block_hash: blockHash, block_number: number, extrinsic_index: index < 0 ? null : index, events_sha256: d.events_sha256, events_length: d.events_length, finalized_utc: nowIso() });
            if (index < 0) { out.status = "finalized-not-found"; out.problem = "the finalized block does not hold the extrinsic"; }
            else if (q[0] !== blockHash) { out.status = "finalized-not-canonical"; out.problem = "the block at that height is " + q[0]; }
            return out;
          });
        });
      });
    }

    /** The bundle checked: its sha256, its JSON and its extrinsic; a refusal, or { bundle, xt, base }. */
    function takeBundle(bundleText, sha256) {
      return sha256Hex(bundleText).then(function (got) {
        if (got !== String(sha256).toLowerCase()) return { refusal: { status: "refused-bundle", problem: "the bundle's sha256 is " + got + ", not " + sha256 } };
        var bundle;
        try { bundle = JSON.parse(bundleText); } catch (e) { return { refusal: { status: "refused-bundle", bundle_sha256: got, problem: "the bundle is not JSON" } }; }
        var xt = bundle && bundle.extrinsic;
        if (typeof xt !== "string" || !HEX.test(xt) || xt.length < 4) return { refusal: { status: "refused-bundle", bundle_sha256: got, problem: "the bundle has no extrinsic hex" } };
        return sha256Hex(xt).then(function (xsha) {
          return { xt: xt, base: { step: bundle.step === undefined ? null : bundle.step, bundle_sha256: got, extrinsic_sha256: xsha, extrinsic_hash: HASH.test(bundle.extrinsic_hash || "") ? bundle.extrinsic_hash : null } };
        });
      });
    }

    /**
     * Submits xt and watches it. mark: whether it goes on the sent list, once the request is written
     * without a throw (X4, F8). A transport that does not report the write is taken to have written
     * once it answers. Once the call has ended nothing of it is written (F7): a deadline before the
     * write ends it as not-sent. The deadline also covers the locate step after finalized: a node
     * that does not answer the block read ends it as finalized-unread with the status's block (F5).
     */
    function submit(xt, base0, mark) {
      var base = Object.assign({}, base0, { submitted_utc: nowIso(), statuses: [] });
      var raw = { statuses: [], events_raw: null };
      return new Promise(function (resolve) {
        var done = false, sub = null, inBlock = null, timer = null, written = false, locating = null, unsubscribed = false;
        function wrote() { if (written) return; written = true; if (mark) store.add(xt); }
        function unwatch() { if (sub && !unsubscribed) { unsubscribed = true; sub.unsubscribe(); } }
        function end(value) {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          unwatch();
          resolve(finish(value, raw));
        }
        timer = setTimeout(function () {
          if (locating !== null) { end(Object.assign({}, base, { status: "finalized-unread", block_hash: locating, problem: "the node reported the block finalized and did not answer the block read before the deadline" })); return; }
          if (!written) { end(Object.assign({}, base, { status: "not-sent", problem: "nothing was written before the deadline: nothing is marked as sent, and nothing of this call will be written" })); return; }
          end(Object.assign({}, base, { status: "deadline", in_block: inBlock, final: false, problem: inBlock ? "in block " + inBlock + ", which did not become final before the deadline" : "not in any block before the deadline; it may still be in the pool" }));
        }, deadlineMs);
        if (typeof t.onLost === "function") t.onLost(function () {
          if (done || !written) return;
          if (locating !== null) { end(Object.assign({}, base, { status: "finalized-unread", block_hash: locating, problem: "the connection was lost while the finalized block was read" })); return; }
          end(Object.assign({}, base, { status: "connection-lost", in_block: inBlock, final: false, problem: "the connection was lost after the extrinsic was written to it: it may be in the pool or in a block" }));
        });
        function onStatus(s) {
          if (done || locating !== null) return;
          raw.statuses.push(s);
          // F4: the table's own keys only; a word such as constructor or __proto__ is unknown
          var w = wordOf(s), kind = w !== null && Object.prototype.hasOwnProperty.call(STATUSES, w) ? STATUSES[w] : undefined;
          base.statuses.push(kind ? w : s);
          if (!kind || kind === "watch") return;
          if (kind === "remember") { inBlock = s.inBlock; return; }
          if (kind === "forget") { inBlock = null; return; }
          if (kind === "final") {
            var h = s.finalized;
            locating = h; unwatch();
            locate(xt, h, base, raw).then(function (v) { end(v); }, function (e) { end(Object.assign({}, base, { status: "finalized-unread", block_hash: h, node: nodeWords(e) })); });
            return;
          }
          end(Object.assign({}, base, { status: "ended", node_status: w, in_block: inBlock, final: false }));
        }
        t.subscribe("author_submitAndWatchExtrinsic", [xt], "author_unwatchExtrinsic", onStatus, wrote, function () { return !done; }).then(function (s) {
          wrote();
          sub = s;
          if (done || locating !== null) unwatch();
        }, function (e) {
          if (!written) { end(Object.assign({}, base, { status: "not-sent", problem: e && e.message === "write-failed" ? "the write to the socket failed: nothing was written, nothing is marked as sent" : "the connection was not open: nothing was written, nothing is marked as sent" })); return; }
          if (e && e.message === LOST && e.written !== undefined) { end(Object.assign({}, base, { status: "connection-lost", in_block: null, final: false, problem: "the connection was lost after the extrinsic was written to it: it may be in the pool or in a block" })); return; }
          end(Object.assign({}, base, { status: "refused-at-submission", node: nodeWords(e) }));
        });
      });
    }

    function send(bundleText, sha256) {
      return takeBundle(bundleText, sha256).then(function (b) {
        if (b.refusal) return finish(Object.assign({}, b.refusal, { sent_by: "send" }), null);
        if (store.has(b.xt)) return finish(Object.assign({}, b.base, { sent_by: "send", status: "already-sent", problem: "this page's sent list holds these bytes: they were written to a socket before. send never sends them twice; sendSame submits the same bytes again" }), null);
        return submit(b.xt, Object.assign({}, b.base, { sent_by: "send" }), true);
      });
    }

    /**
     * Submits again an extrinsic the sent list holds, and refuses one it does not hold (X5). This is
     * safe: the same bytes carry the same account nonce, so the chain can include them once at
     * most. A different copy of a step is never made in the pane.
     */
    function sendSame(bundleText, sha256) {
      return takeBundle(bundleText, sha256).then(function (b) {
        if (b.refusal) return finish(Object.assign({}, b.refusal, { sent_by: "sendSame" }), null);
        if (!store.has(b.xt)) return finish(Object.assign({}, b.base, { sent_by: "sendSame", status: "not-in-sent-list", problem: "sendSame sends only what send sent before; use send" }), null);
        return submit(b.xt, Object.assign({}, b.base, { sent_by: "sendSame" }), false);
      });
    }

    /**
     * Reads finalized blocks from fromNumber up to the finalized head, at most 400 a call, and looks
     * for the extrinsic (X6). Returns what send returns for a finalized extrinsic, or not-found with
     * the range it read and the head. It ends within the runner's deadline (H10): if it has not
     * finished, the outcome is find-deadline with the blocks it read (from, to: the last block of the
     * blocks read one after another from fromNumber, null when none) and the head; nothing more is
     * asked of the node after that. A block found and not read by the deadline is finalized-unread.
     */
    function find(extrinsicHex, fromNumber) {
      if (typeof extrinsicHex !== "string" || !HEX.test(extrinsicHex) || extrinsicHex.length < 4) return finish({ status: "refused-bundle", sent_by: "find", problem: "find needs the extrinsic as 0x hex" }, null);
      if (!Number.isSafeInteger(fromNumber) || fromNumber < 0) return finish({ status: "refused-bundle", sent_by: "find", problem: "find needs a block number to start from" }, null);
      return sha256Hex(extrinsicHex).then(function (xsha) {
        var base = { step: null, bundle_sha256: null, extrinsic_sha256: xsha, extrinsic_hash: null, found_by: "find", sent_by: "find", statuses: [] };
        var raw = { statuses: [], events_raw: null };
        return new Promise(function (resolve, reject) {
          var done = false, head = null, readTo = null, locating = null, timer = null;
          function end(value) { if (done) return; done = true; clearTimeout(timer); resolve(finish(value, raw)); }
          function fail(e) { if (done) return; done = true; clearTimeout(timer); reject(e); }
          timer = setTimeout(function () {
            if (locating !== null) { end(Object.assign({}, base, { status: "finalized-unread", block_hash: locating, problem: "find found the extrinsic in this finalized block and did not read the block before the deadline" })); return; }
            end(Object.assign({}, base, { status: "find-deadline", from: fromNumber, to: readTo, head: head, problem: readTo === null ? "find did not finish before the deadline and read no block" : "find did not finish before the deadline: it read the finalized blocks " + fromNumber + " to " + readTo + " and the extrinsic is not in them" }));
          }, deadlineMs);
          heads().then(function (h) {
            if (done) return;
            head = h.finalized.number;
            var to = Math.min(head, fromNumber + FIND_MAX - 1), n = fromNumber;
            function chunk() {
              if (done) return;
              if (n > to) { end(Object.assign({}, base, { status: "not-found", from: fromNumber, to: to < fromNumber ? null : to, head: head, problem: to < fromNumber ? "the finalized head is below the block to start from" : "not in any finalized block read" })); return; }
              var nums = [];
              for (var i = 0; i < 20 && n <= to; i++, n++) nums.push(n);
              Promise.all(nums.map(function (k) {
                return t.request("chain_getBlockHash", [k]).then(function (bh) { return t.request("chain_getBlock", [bh]).then(function (b) { return { hash: bh, has: b.block.extrinsics.indexOf(extrinsicHex) >= 0 }; }); });
              })).then(function (rs) {
                if (done) return;
                for (var j = 0; j < rs.length; j++) if (rs[j].has) { locating = rs[j].hash; locate(extrinsicHex, rs[j].hash, base, raw).then(end, fail); return; }
                readTo = nums[nums.length - 1];
                chunk();
              }, fail);
            }
            chunk();
          }, fail);
        });
      });
    }

    lab.heads = heads; lab.read = read; lab.accountReads = accountReads; lab.deviceReads = deviceReads;
    lab.send = send; lab.sendSame = sendSame; lab.find = find;
    return lab;
  }

  root.paneRunner = { createRunner: createRunner, wsTransport: wsTransport, sha256Hex: sha256Hex, RPC: RPC, EVENTS_KEY: EVENTS_KEY, STATUSES: STATUSES, OUTCOMES: OUTCOMES };
})(globalThis);
