// loopguard.js — the two sync-id guards that stop the bidirectional loop
// (edit -> mirror -> watcher -> write -> edit -> ...). Ports overleaf-cli §9.
// Pure/stdlib and unit-tested; `now` is injectable for deterministic tests.

const DEFAULT_TTL = 10_000; // ms

/**
 * Edit-echo guard (browser end). When we submit an OT op to Overleaf we record
 * a signature; when the CDP monitor sees the echoed applyOtUpdate we drop it
 * instead of writing it back to the mirror.
 */
export class EditEchoGuard {
  constructor({ ttl = DEFAULT_TTL, now = () => Date.now() } = {}) {
    this.ttl = ttl;
    this.now = now;
    this.recent = new Map(); // sig -> expiry
  }
  static sig(docId, op) {
    // op signature stable across the echo: docId + ordered (i/d,p) tuples.
    const ops = (op || [])
      .map((o) => (o.i != null ? `i${o.p}:${o.i}` : o.d != null ? `d${o.p}:${o.d}` : `r${o.p}`))
      .join("|");
    return `${docId}#${ops}`;
  }
  markSubmitted(docId, op) {
    this.recent.set(EditEchoGuard.sig(docId, op), this.now() + this.ttl);
  }
  /** True if this inbound edit is our own echo and should be dropped. */
  shouldDrop(docId, op) {
    this._sweep();
    const s = EditEchoGuard.sig(docId, op);
    if (this.recent.has(s)) {
      this.recent.delete(s);
      return true;
    }
    return false;
  }
  _sweep() {
    const t = this.now();
    for (const [k, exp] of this.recent) if (exp < t) this.recent.delete(k);
  }
}

/**
 * Filesystem sync-id guard. Server-originated mirror writes carry a syncId;
 * when chokidar reports a change for a path with a known syncId, we ACK it
 * instead of pushing the change back to Overleaf.
 */
export class FsSyncGuard {
  constructor({ ttl = DEFAULT_TTL, now = () => Date.now() } = {}) {
    this.ttl = ttl;
    this.now = now;
    this.pending = new Map(); // path -> expiry
  }
  markWrite(filePath) {
    this.pending.set(filePath, this.now() + this.ttl);
  }
  /** True if this fs change was caused by our own inbound-sync write. */
  isOwnWrite(filePath) {
    const exp = this.pending.get(filePath);
    if (exp == null) return false;
    this.pending.delete(filePath);
    return exp >= this.now();
  }
}
