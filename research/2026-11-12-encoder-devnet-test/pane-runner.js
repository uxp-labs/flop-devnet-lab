// pane-runner.js: paste into a browser page (the browser pane). No import, no library.
// It talks JSON-RPC to the devnet node and does only this:
//   heads()                       the runtime's four names, and the finalized head's number and hash
//   read(keys, blockHash)         the raw stored values of the given keys at that block
//   deviceReads(account, key)     heads(), the account's next nonce and the raw value at key: the
//                                 --reads of sign-device.mjs, the session nonce left raw
//   send(bundleText, sha256)      submits the bundle's one signed extrinsic, once, and waits until it
//                                 is in a finalized block or the deadline passes; returns the block's
//                                 hash and number, the extrinsic's index and the raw System.Events
// It decodes nothing. It refuses a bundle whose sha256 is not the one given. It never sends the same
// extrinsic twice. An extrinsic the node refuses at submission is reported with the node's words and
// is not retried.
//
// Use, in the page's console:
//   const lab = paneRunner.createRunner({ transport: paneRunner.wsTransport("<RPC of steps.json>"), eventsKey: "<EVENTS_KEY of steps.json>" });
//   await lab.heads();
//   await lab.send(`<text of signed/T3.json>`, "<its sha256>");
//
// A transport is { request(method, params) -> Promise<result>, subscribe(method, params, unsubscribeMethod,
// onNotification) -> Promise<{ unsubscribe() }> }. A node error rejects with { code, message, data }.
(function (root) {
  "use strict";

  var HEX = /^0x([0-9a-f]{2})*$/;
  var HASH = /^0x[0-9a-f]{64}$/;

  function nodeWords(e) {
    if (e && typeof e === "object" && ("code" in e || "message" in e)) return { code: e.code === undefined ? null : e.code, message: e.message === undefined ? null : String(e.message), data: e.data === undefined ? null : e.data };
    return { code: null, message: String(e), data: null };
  }

  function hexOfBuffer(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  function sha256Hex(text) {
    return root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(hexOfBuffer);
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

  /** A JSON-RPC transport over one WebSocket. */
  function wsTransport(url, WebSocketCtor) {
    var Ctor = WebSocketCtor || root.WebSocket;
    var ws = new Ctor(url);
    var nextId = 1, pending = {}, subs = {}, early = {};
    var open = new Promise(function (resolve, reject) {
      ws.onopen = function () { resolve(); };
      ws.onerror = function () { reject({ code: null, message: "the connection to " + url + " failed", data: null }); };
    });
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
    function request(method, params) {
      return open.then(function () {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          pending[id] = { resolve: resolve, reject: reject };
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params }));
        });
      });
    }
    function subscribe(method, params, unsubscribeMethod, onNotification) {
      return request(method, params).then(function (sid) {
        subs[sid] = onNotification;
        (early[sid] || []).forEach(onNotification);
        delete early[sid];
        return { unsubscribe: function () { delete subs[sid]; return request(unsubscribeMethod, [sid]).catch(function () { return null; }); } };
      });
    }
    return { request: request, subscribe: subscribe, close: function () { ws.close(); } };
  }

  function createRunner(opts) {
    var t = opts.transport;
    if (!t || typeof t.request !== "function" || typeof t.subscribe !== "function") throw new Error("pane-runner: a transport with request and subscribe is required");
    if (typeof opts.eventsKey !== "string" || !HEX.test(opts.eventsKey)) throw new Error("pane-runner: eventsKey (EVENTS_KEY of steps.json) is required");
    var deadlineMs = opts.deadlineMs === undefined ? 120000 : opts.deadlineMs;
    var store = opts.store || defaultStore();
    var nowIso = opts.nowIso || function () { return new Date().toISOString(); };

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

    function deviceReads(account, sessionNonceKey) {
      return heads().then(function (h) {
        return Promise.all([t.request("system_accountNextIndex", [account]), read([sessionNonceKey], h.finalized.hash)]).then(function (r) {
          if (r[1].not_answered.length) throw new Error("pane-runner: the node did not answer the session nonce key");
          return { runtime: h.runtime, birth: { number: h.finalized.number, hash: h.finalized.hash }, account_nonce: r[0], session_nonce_raw: r[1].values[sessionNonceKey] };
        });
      });
    }

    /** After a finalized status: where the extrinsic is, and the raw events of its block. */
    function locate(xt, blockHash, base) {
      return Promise.all([t.request("chain_getHeader", [blockHash]), t.request("chain_getBlock", [blockHash])]).then(function (r) {
        var number = parseInt(r[0].number, 16);
        var index = r[1].block.extrinsics.indexOf(xt);
        return Promise.all([t.request("chain_getBlockHash", [number]), t.request("state_getStorage", [opts.eventsKey, blockHash])]).then(function (q) {
          var out = Object.assign({}, base, { block_hash: blockHash, block_number: number, extrinsic_index: index < 0 ? null : index, events_raw: q[1] === undefined ? null : q[1], finalized_utc: nowIso() });
          if (index < 0) { out.status = "finalized-not-found"; out.problem = "the finalized block does not hold the extrinsic"; }
          else if (q[0] !== blockHash) { out.status = "finalized-not-canonical"; out.problem = "the block at that height is " + q[0]; }
          return out;
        });
      });
    }

    function send(bundleText, sha256) {
      return sha256Hex(bundleText).then(function (got) {
        if (got !== String(sha256).toLowerCase()) return { status: "refused-bundle", problem: "the bundle's sha256 is " + got + ", not " + sha256 };
        var bundle;
        try { bundle = JSON.parse(bundleText); } catch (e) { return { status: "refused-bundle", problem: "the bundle is not JSON" }; }
        var xt = bundle && bundle.extrinsic;
        if (typeof xt !== "string" || !HEX.test(xt) || xt.length < 4) return { status: "refused-bundle", problem: "the bundle has no extrinsic hex" };
        if (store.has(xt)) return { status: "already-sent", problem: "this extrinsic was sent before: it is never sent twice" };
        store.add(xt);
        var base = { step: bundle.step === undefined ? null : bundle.step, extrinsic_hash: HASH.test(bundle.extrinsic_hash || "") ? bundle.extrinsic_hash : null, submitted_utc: nowIso(), statuses: [] };
        return new Promise(function (resolve) {
          var done = false, sub = null, inBlock = null, timer = null;
          function finish(result) {
            if (done) return;
            done = true;
            if (timer !== null) clearTimeout(timer);
            if (sub) sub.unsubscribe();
            resolve(result);
          }
          timer = setTimeout(function () {
            finish(Object.assign({}, base, { status: "deadline", in_block: inBlock, final: false, problem: inBlock ? "in block " + inBlock + ", which did not become final before the deadline" : "not in any block before the deadline" }));
          }, deadlineMs);
          function onStatus(s) {
            if (done) return;
            base.statuses.push(s);
            if (typeof s === "string") return; // future, ready, broadcast
            if (s && s.inBlock) { inBlock = s.inBlock; return; }
            if (s && s.retracted) { inBlock = null; return; }
            if (s && s.finalized) { var h = s.finalized; done = true; clearTimeout(timer); if (sub) sub.unsubscribe(); locate(xt, h, Object.assign({ status: "finalized" }, base)).then(resolve, function (e) { resolve(Object.assign({}, base, { status: "finalized-unread", block_hash: h, node: nodeWords(e) })); }); return; }
            var word = s && typeof s === "object" ? Object.keys(s)[0] : String(s);
            finish(Object.assign({}, base, { status: "ended", node_status: word, in_block: inBlock, final: false }));
          }
          t.subscribe("author_submitAndWatchExtrinsic", [xt], "author_unwatchExtrinsic", onStatus).then(function (s) {
            sub = s;
            if (done) s.unsubscribe();
          }, function (e) {
            finish(Object.assign({}, base, { status: "refused-at-submission", node: nodeWords(e) }));
          });
        });
      });
    }

    return { heads: heads, read: read, deviceReads: deviceReads, send: send };
  }

  root.paneRunner = { createRunner: createRunner, wsTransport: wsTransport, sha256Hex: sha256Hex };
})(globalThis);
