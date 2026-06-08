// cdp.js — observe Overleaf's own WebSocket traffic via the Chrome DevTools
// Protocol, instead of injecting a page hook. We never speak the Socket.IO
// handshake ourselves; we ride the real app's authenticated socket and parse
// the frames it already exchanges (project tree, doc contents+ranges, live
// edits). This is robust to UI changes and sidesteps the www-vs-cn protocol
// uncertainty (see plan).
//
// Correlation: joinDoc is a request/ack pair. We remember each outbound
// request's ack-seq + name so that when its ack frame returns we know it was a
// joinDoc for a specific docId and can decode [null, lines, version, ranges].

import { EventEmitter } from "node:events";
import { parseFrame, decodeApplyOtUpdate, decodeJoinDoc } from "./socketio.js";

export class CdpCapture extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map(); // ack-seq -> { name, args }
  }

  _onSent(payload) {
    const f = parseFrame(payload);
    if (!f || f.type !== "event") return;
    if (f.ack != null) this.pending.set(f.ack, { name: f.name, args: f.args });
    this.emit("sent", f);
    if (f.name === "applyOtUpdate") {
      const ot = decodeApplyOtUpdate(f.args);
      if (ot) this.emit("applyOtUpdate", { ...ot, origin: "local-or-echo" });
    }
  }

  _onReceived(payload) {
    const f = parseFrame(payload);
    if (!f) return;
    this.emit("frame", f);

    if (f.type === "event") {
      if (f.name === "joinProjectResponse" || f.name === "joinProject") {
        const project = f.args && f.args[0] && (f.args[0].project || f.args[0]);
        if (project) this.emit("project", project);
      }
      if (f.name === "applyOtUpdate") {
        const ot = decodeApplyOtUpdate(f.args);
        if (ot) this.emit("remoteEdit", { ...ot, origin: "remote" });
      }
      if (f.name === "otUpdateApplied") {
        const ot = decodeApplyOtUpdate(f.args);
        if (ot) this.emit("remoteEdit", { ...ot, origin: "remote" });
      }
      // Tree changes broadcast by Overleaf (other clients or REST). Shapes:
      //   reciveNewDoc/reciveNewFile [parentFolderId, {name,_id}, ...]
      //   reciveNewFolder           [parentFolderId, {name,_id,...}, ...]
      //   reciveEntityRename        [entityId, newName]
      //   reciveEntityMove          [entityId, destFolderId]
      //   removeEntity              [entityId, source]
      if (f.name === "reciveNewDoc" || f.name === "reciveNewFile") {
        const [parentFolderId, e] = f.args || [];
        if (e && e._id) this.emit("treeNew", { kind: f.name === "reciveNewDoc" ? "doc" : "file", parentFolderId, id: e._id, name: e.name });
      }
      if (f.name === "reciveNewFolder") {
        const [parentFolderId, e] = f.args || [];
        if (e && e._id) this.emit("treeNewFolder", { parentFolderId, id: e._id, name: e.name });
      }
      if (f.name === "reciveEntityRename") {
        const [id, name] = f.args || [];
        if (id) this.emit("treeRename", { id, name });
      }
      if (f.name === "reciveEntityMove") {
        const [id, destFolderId] = f.args || [];
        if (id) this.emit("treeMove", { id, destFolderId });
      }
      if (f.name === "removeEntity") {
        const [id] = f.args || [];
        if (id) this.emit("treeRemove", { id });
      }
      return;
    }

    if (f.type === "ack") {
      const req = this.pending.get(f.ack);
      if (!req) return;
      this.pending.delete(f.ack);
      if (req.name === "joinDoc") {
        const docId = req.args && req.args[0];
        const decoded = decodeJoinDoc(f.args);
        if (decoded) this.emit("joinDoc", { docId, ...decoded });
      }
      this.emit("ack", { req, args: f.args });
    }
  }
}

/**
 * Attach CDP frame capture to a Playwright page. Returns the CdpCapture
 * emitter. Frames are surfaced as 'project', 'joinDoc', 'remoteEdit', etc.
 *
 * opts.onRaw(direction, payload) — if given, called for EVERY frame (sent or
 * received) with the raw payload string, regardless of whether it parsed. Use
 * it to diagnose protocol/format mismatches (`pull --debug-frames`).
 */
export async function attachCapture(context, page, opts = {}) {
  const cap = new CdpCapture();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", (e) => {
    const p = e.response && e.response.payloadData;
    if (opts.onRaw) opts.onRaw("sent", p);
    cap._onSent(p);
  });
  cdp.on("Network.webSocketFrameReceived", (e) => {
    const p = e.response && e.response.payloadData;
    if (opts.onRaw) opts.onRaw("recv", p);
    cap._onReceived(p);
  });
  cap.detach = () => cdp.detach().catch(() => {});
  return cap;
}
