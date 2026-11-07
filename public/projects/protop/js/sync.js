// Polling for one room: GET /rooms/<id>/sync about every 1.5 s while the tab is visible and every 15 s while it
// is hidden, with exponential backoff (and Retry-After) when the server does not answer. Failures are quiet:
// after two in a row the state becomes "reconnecting", never an alert and never a flood of console output.

import { get, post, ApiError, roomPath } from './api.js';

const VISIBLE_MS = 1500;
const HIDDEN_MS = 15000;
const MAX_BACKOFF_MS = 30000;

export class Syncer {
  /**
   * @param {object} o
   * @param {string} o.roomId
   * @param {string} o.client      random per-tab id, 8..32 of [A-Za-z0-9_-]
   * @param {() => number} o.getSeq   highest seq applied so far
   * @param {(ops: object[]) => void} o.onOps
   * @param {(presence: object[]) => void} o.onPresence
   * @param {(state: 'connecting'|'live'|'reconnecting'|'gone') => void} o.onState
   */
  constructor(o) {
    Object.assign(this, o);
    this.fails = 0;
    this.timer = null;
    this.stopped = true;
    this.inflight = false;
    this.state = 'connecting';
    this.presence = null; // last presence we want the server to hold
    this.presenceSent = false;
    this.presenceBusy = false;
    this.presenceDirty = false;
    this.presenceTimer = null;
    this.lastPresencePost = 0;
    this.onVisible = () => { if (!this.stopped) this.schedule(document.hidden ? HIDDEN_MS : 150); };
    this.onOnline = () => { if (!this.stopped) { this.fails = 0; this.schedule(150); } };
  }

  start() {
    this.stopped = false;
    document.addEventListener('visibilitychange', this.onVisible);
    addEventListener('online', this.onOnline);
    this.schedule(0);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.presenceTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    removeEventListener('online', this.onOnline);
  }
  /** Ask for an early sync (after we sent an op, say). */
  poke() { if (!this.stopped && this.fails === 0) this.schedule(120); }

  setState(s) { if (s !== this.state) { this.state = s; this.onState(s); } }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  async tick() {
    if (this.stopped) return;
    if (this.inflight) { this.schedule(300); return; }
    this.inflight = true;
    let next = document.hidden ? HIDDEN_MS : VISIBLE_MS;
    try {
      const r = await get(`${roomPath(this.roomId)}/sync?since=${this.getSeq()}&client=${encodeURIComponent(this.client)}`, { timeout: 12000 });
      if (this.stopped) return;
      this.fails = 0;
      if (Array.isArray(r.ops) && r.ops.length) this.onOps(r.ops);
      this.onPresence(Array.isArray(r.presence) ? r.presence : []);
      this.setState('live');
      // The server forgets presence after 20 s without a heartbeat only for the "seen" part; re-send our details
      // now and then (and right after any outage) so a restarted server still shows our name.
      if (this.presence && (!this.presenceSent || Date.now() - this.lastPresencePost > 60000)) this.sendPresence();
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof ApiError && e.status === 404) { this.setState('gone'); this.stopped = true; return; }
      this.fails++;
      this.presenceSent = false;
      next = Math.min(MAX_BACKOFF_MS, (document.hidden ? HIDDEN_MS : VISIBLE_MS) * 2 ** Math.min(this.fails, 5));
      if (e instanceof ApiError && e.retryAfter) next = Math.max(next, Math.min(60, e.retryAfter) * 1000);
      next += Math.random() * 400;
      if (this.fails >= 2) this.setState('reconnecting');
    } finally {
      this.inflight = false;
    }
    this.schedule(next);
  }

  /** Tell the room who we are and what we have selected. Coalesced: only the newest value is ever sent. */
  setPresence(p) {
    this.presence = p;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => this.sendPresence(), 200);
  }
  async sendPresence() {
    if (this.stopped || !this.presence) return;
    if (this.presenceBusy) { this.presenceDirty = true; return; }
    this.presenceBusy = true;
    const body = { client: this.client, ...this.presence };
    try {
      await post(`${roomPath(this.roomId)}/presence`, body, { timeout: 8000 });
      this.presenceSent = true;
      this.lastPresencePost = Date.now();
    } catch { /* the next sync tick will retry; nothing to tell the user */ }
    this.presenceBusy = false;
    if (this.presenceDirty) { this.presenceDirty = false; this.sendPresence(); }
  }
}
