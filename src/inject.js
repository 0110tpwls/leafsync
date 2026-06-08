// inject.js — page init-script that lets us SEND requests over Overleaf's own
// authenticated Socket.IO connection (and tap incoming edits), without
// re-implementing the handshake.
//
// Why: passive CDP sniffing can READ frames but cannot SEND them, and the app
// only joinDoc's the root doc. To pull every doc's ranges (comments) — and, in
// later phases, to push applyOtUpdate edits — we wrap window.WebSocket before
// the app loads, keep the live socket, and expose helpers on window:
//
//   __olsyncReady()              -> bool: socket open and hooked
//   __olsyncRequest(name, args)  -> Promise(ackBody): send `5:<seq>+::{name,args}`,
//                                   resolve on the matching `6:::<seq>+<body>`
//   __olsyncSend(name, args)     -> fire-and-forget event (no ack)
//   __olsyncDrainEdits()         -> array of buffered incoming otUpdateApplied args
//
// www.overleaf.com speaks legacy Socket.IO 0.9 (verified from frames.log):
//   5:::{json}            server event (no ack)
//   5:<seq>+::{json}      client event expecting ack
//   6:::<seq>+<body>      ack/response
//   2::                   heartbeat
//
// Pure browser code; serialized by Playwright's addInitScript.

export function injectedHook() {
  if (window.__olsyncInstalled) return;
  window.__olsyncInstalled = true;

  const Native = window.WebSocket;
  let sock = null;
  const pending = new Map(); // seq -> resolve
  let seq = 100000; // start high so we never collide with the app's own seqs
  const edits = []; // buffered incoming otUpdateApplied args
  const stats = { hooked: 0, sent: 0, acks: 0 }; // diagnostics

  function onFrame(data) {
    if (typeof data !== "string") return;
    // ack: 6:::<seq>+<body>
    const ack = /^6:::(\d+)\+?([\s\S]*)$/.exec(data);
    if (ack) {
      const id = Number(ack[1]);
      const p = pending.get(id);
      if (p) {
        stats.acks++;
        pending.delete(id);
        let body = null;
        try {
          body = ack[2] ? JSON.parse(ack[2]) : null;
        } catch (e) {
          /* leave null */
        }
        p(body);
      }
      return;
    }
    // event: 5:::{json}  or  5:<seq>+::{json}
    const ev = /^5:(?:\d+\+)?::([\s\S]*)$/.exec(data);
    if (ev) {
      try {
        const o = JSON.parse(ev[1]);
        // The server broadcasts other clients' edits as otUpdateApplied.
        if (o && (o.name === "otUpdateApplied" || o.name === "applyOtUpdate")) {
          edits.push(o.args);
          if (edits.length > 500) edits.shift(); // cap (long sessions)
        }
      } catch (e) {
        /* ignore non-JSON */
      }
    }
  }

  function hook(ws) {
    sock = ws;
    stats.hooked++;
    try {
      ws.addEventListener("message", (e) => onFrame(e.data));
      ws.addEventListener("close", () => {
        if (sock === ws) sock = null;
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Wrap the constructor so we capture whatever socket the app opens.
  function WrappedWS() {
    const ws = new Native(...arguments);
    try {
      hook(ws);
    } catch (e) {
      /* ignore */
    }
    return ws;
  }
  WrappedWS.prototype = Native.prototype;
  // The readyState constants are non-enumerable, so copy them explicitly —
  // app code that reads WebSocket.OPEN must still work.
  WrappedWS.CONNECTING = Native.CONNECTING;
  WrappedWS.OPEN = Native.OPEN;
  WrappedWS.CLOSING = Native.CLOSING;
  WrappedWS.CLOSED = Native.CLOSED;
  window.WebSocket = WrappedWS;

  window.__olsyncReady = () => !!(sock && sock.readyState === 1);

  window.__olsyncRequest = (name, args) =>
    new Promise((resolve, reject) => {
      if (!sock || sock.readyState !== 1) return reject(new Error("socket not ready"));
      const id = ++seq;
      pending.set(id, resolve);
      try {
        sock.send("5:" + id + "+::" + JSON.stringify({ name, args }));
        stats.sent++;
      } catch (e) {
        pending.delete(id);
        return reject(e);
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("ack timeout"));
        }
      }, 15000);
    });

  window.__olsyncSend = (name, args) => {
    if (!sock || sock.readyState !== 1) return false;
    try {
      sock.send("5:::" + JSON.stringify({ name, args }));
      return true;
    } catch (e) {
      return false;
    }
  };

  window.__olsyncDrainEdits = () => {
    const out = edits.slice();
    edits.length = 0;
    return out;
  };

  window.__olsyncStats = () => ({ ...stats, ready: !!(sock && sock.readyState === 1) });
}
