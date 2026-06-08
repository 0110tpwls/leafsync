// socketio.js — parse Overleaf's (legacy) Socket.IO wire frames.
//
// PURE / stdlib-only so it can be unit-tested without a browser. cdp.js feeds
// raw frame payload strings (captured via CDP Network.webSocketFrame*) into
// parseFrame(); the higher layers match on the decoded event name/args.
//
// Frame grammar (reconstructed from overleaf-cli's overleaf-websocket.ts, the
// classic Socket.IO 0.9/1.x format, engine path /socket.io/1/):
//   "2::"                  heartbeat ping              -> {type:'heartbeat'}
//   "5:::{json}"           event, no ack               -> {type:'event', name, args}
//   "5:<seq>+::{json}"     event expecting ack         -> {type:'event', name, args, ack:<seq>}
//   "6:::<seq>+{body}"     ack/response to <seq>       -> {type:'ack', ack:<seq>, args}
//   "7:::{msg}"            error                       -> {type:'error', message}
//   "1::" / "0::"          connect / disconnect        -> {type:'connect'|'disconnect'}
//
// NOTE: www.overleaf.com may run a newer Engine.IO/Socket.IO whose framing
// differs (e.g. "42[...]" Socket.IO v2+). parseFrame() also recognises that
// shape so the same capture path works if the live site has upgraded; verify
// against the real site during implementation (see plan "Open items").

/** Parse one raw Socket.IO frame string. Returns null if unrecognised. */
export function parseFrame(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // --- Engine.IO v3+/Socket.IO v2+ : "<enginePacket><socketPacket>[json]" ---
  // e.g. "42[\"applyOtUpdate\", ...]" (4=message, 2=event), "2"=ping, "3"=pong.
  if (/^[0-9]{1,2}\[/.test(raw) || raw === "2" || raw === "3") {
    if (raw === "2") return { type: "heartbeat" };
    if (raw === "3") return { type: "pong" };
    const br = raw.indexOf("[");
    const head = raw.slice(0, br);
    // head is like "42" (msg+event) or "42<ackId>" (msg+event+ackId)
    const ackMatch = head.slice(2);
    const json = safeJson(raw.slice(br));
    if (!Array.isArray(json)) return null;
    const [name, ...args] = json;
    return {
      type: "event",
      name,
      args,
      ack: ackMatch ? Number(ackMatch) : undefined,
    };
  }

  // --- Legacy Socket.IO 0.9/1.x : "<type>:<id>:<endpoint>:<data>" ---
  const m = raw.match(/^(\d):([^:]*):([^:]*):?([\s\S]*)$/);
  if (!m) return null;
  const [, type, id, , data] = m;

  switch (type) {
    case "0":
      return { type: "disconnect" };
    case "1":
      return { type: "connect" };
    case "2":
      return { type: "heartbeat" };
    case "5": {
      const obj = safeJson(data);
      if (!obj || typeof obj !== "object") return null;
      const ack = id.endsWith("+") ? Number(id.slice(0, -1)) : undefined;
      return { type: "event", name: obj.name, args: obj.args || [], ack };
    }
    case "6": {
      // ack: data begins "<seq>+<json?>"
      const plus = data.indexOf("+");
      const seq = plus >= 0 ? Number(data.slice(0, plus)) : Number(id);
      const body = plus >= 0 ? safeJson(data.slice(plus + 1)) : null;
      return { type: "ack", ack: seq, args: Array.isArray(body) ? body : body == null ? [] : [body] };
    }
    case "7":
      return { type: "error", message: data };
    default:
      return null;
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Decode an applyOtUpdate / otUpdateApplied event's args into
 * { docId, op, version, meta }. Three shapes occur on www.overleaf.com:
 *
 *   client SEND  applyOtUpdate : [docId, { op, v }]
 *   server CAST  otUpdateApplied: [{ op, v, meta }]      (a REMOTE edit — note:
 *                                                         NO doc id; route by v)
 *   server ACK   otUpdateApplied: [{ v }]                (our own push confirmed;
 *                                                         op absent)
 *
 * docId is undefined for the broadcast/ack forms (the frame omits it); callers
 * route those by version. Verified live: a remote edit arrives as
 * `[{"op":[…],"v":N,"meta":{source,user_id,ts}}]`.
 */
export function decodeApplyOtUpdate(args) {
  if (!Array.isArray(args) || args.length === 0) return null;
  const [a, b] = args;
  // two-arg form: [docId, {op,v}]
  if (typeof a === "string" && b && typeof b === "object" && !Array.isArray(b)) {
    return { docId: a, op: Array.isArray(b.op) ? b.op : [], version: b.v, meta: b.meta };
  }
  // single-object form: [{op?,v,meta?,doc?}] (broadcast or sender ack)
  if (a && typeof a === "object" && !Array.isArray(a)) {
    return { docId: a.doc || a.doc_id || undefined, op: Array.isArray(a.op) ? a.op : [], version: a.v, meta: a.meta };
  }
  return null;
}

/**
 * Decode a joinDoc ack body. The classic shape is
 *   [null, lines[], version, ranges]
 * but www.overleaf.com returns a 6-element form
 *   [null, lines[], version, changes[], ranges{comments,changes}, otType]
 * where the ranges object sits at index 4, not 3. Rather than hardcode an
 * index, findRanges() scans for the object that actually carries comments.
 * Returns { lines, version, ranges } (ranges null when none).
 */
export function decodeJoinDoc(args) {
  if (!Array.isArray(args)) return null;
  // ack args from parseFrame for a "6" frame is the decoded body array itself.
  const body = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  const lines = body[1];
  if (!Array.isArray(lines)) return null;
  return { lines, version: body[2], ranges: findRanges(body) };
}

/** Find the ranges object ({comments|changes}) anywhere after lines/version. */
export function findRanges(body) {
  if (!Array.isArray(body)) return null;
  for (let i = 2; i < body.length; i++) {
    const e = body[i];
    if (e && typeof e === "object" && !Array.isArray(e) && (Array.isArray(e.comments) || Array.isArray(e.changes))) {
      return e;
    }
  }
  return null;
}
