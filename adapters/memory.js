'use strict';

/**
 * MemoryAdapter — zero-dependency in-memory storage adapter.
 *
 * Data is not persisted across restarts. Ideal for:
 *   - Testing (expose .messages / .media / .sessions for seeding)
 *   - Stateless / serverless deployments
 *   - Users who bring their own storage
 */
class MemoryAdapter {
  constructor() {
    /** @type {Array<{id:number, wx_id:string, direction:string, content:string, ts:string, pair_id:number}>} */
    this.messages = [];
    /** @type {Array<{id:number, wx_id:string, pair_id:number, direction:string, media_type:string, mime:string, data:Buffer, ts:string}>} */
    this.media    = [];
    /** @type {Array<{wx_id:string, nickname:string, preset_type:string, preset_command:string|null, preset_dir:string|null, tts_voice:string|null, last_active:string|null}>} */
    this.sessions = [];
    this._nextMessageId = 1;
    this._nextMediaId   = 1;
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  getUnpairedMessages() {
    return this.messages
      .filter(m => m.pair_id === 0)
      .sort((a, b) => {
        if (a.wx_id < b.wx_id) return -1;
        if (a.wx_id > b.wx_id) return 1;
        return a.ts.localeCompare(b.ts);
      })
      .map(({ id, wx_id, direction }) => ({ id, wx_id, direction }));
  }

  updateMessagePairIds(updates) {
    for (const { id, pairId } of updates) {
      const m = this.messages.find(m => m.id === id);
      if (m) m.pair_id = pairId;
    }
  }

  getMaxPairIds() {
    const maxes = new Map();
    for (const m of this.messages) {
      if (!maxes.has(m.wx_id) || m.pair_id > maxes.get(m.wx_id)) {
        maxes.set(m.wx_id, m.pair_id);
      }
    }
    return [...maxes.entries()].map(([wx_id, max_pair]) => ({ wx_id, max_pair }));
  }

  saveMessage(wxId, direction, content, pairId, ts) {
    this.messages.push({
      id: this._nextMessageId++,
      wx_id: wxId, direction, content,
      ts: ts || new Date().toISOString(),
      pair_id: pairId,
    });
  }

  deleteOldMessages(cutoffTs) {
    const before = this.messages.length;
    this.messages = this.messages.filter(m => m.ts >= cutoffTs);
    return { changes: before - this.messages.length };
  }

  getRounds(wxId, limit, offset) {
    let msgs = this.messages.filter(m => m.pair_id > 0);
    if (wxId) msgs = msgs.filter(m => m.wx_id === wxId);

    // Group by wx_id + pair_id (pivot: in / out into one row)
    const groups = new Map();
    for (const m of msgs) {
      const key = `${m.wx_id}:${m.pair_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          wx_id: m.wx_id, pair_id: m.pair_id,
          in_content: null, in_ts: null,
          out_content: null, out_ts: null,
          out_media_id: null, out_media_type: null,
        });
      }
      const g = groups.get(key);
      if (m.direction === 'in') { g.in_content = m.content; g.in_ts = m.ts; }
      else                       { g.out_content = m.content; g.out_ts = m.ts; }
    }

    const rounds = [...groups.values()];

    // Left-join media (first matching out-direction record)
    for (const r of rounds) {
      const med = this.media.find(
        m => m.wx_id === r.wx_id && m.pair_id === r.pair_id && m.direction === 'out'
      );
      if (med) { r.out_media_id = med.id; r.out_media_type = med.media_type; }
    }

    rounds.sort((a, b) => (b.in_ts || '').localeCompare(a.in_ts || ''));
    const total = rounds.length;
    return { rounds: rounds.slice(offset, offset + limit), total };
  }

  getMessages(wxId, limit, offset) {
    let rows = this.messages.map(({ id, wx_id, direction, content, ts }) =>
      ({ id, wx_id, direction, content, ts })
    );
    if (wxId) rows = rows.filter(m => m.wx_id === wxId);
    rows.sort((a, b) => b.ts.localeCompare(a.ts));
    const total = rows.length;
    return { messages: rows.slice(offset, offset + limit), total };
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  saveMedia(wxId, pairId, direction, mediaType, mime, data, ts) {
    const id = this._nextMediaId++;
    this.media.push({
      id, wx_id: wxId, pair_id: pairId, direction,
      media_type: mediaType, mime, data,
      ts: ts || new Date().toISOString(),
    });
    return id;
  }

  getMedia(id) {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const item = this.media.find(m => m.id === numId);
    return item ? { mime: item.mime, data: item.data } : null;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  upsertSession(wxId, nickname, presetType, presetCommand, presetDir, ttsVoice, lastActive, contextToken) {
    const idx = this.sessions.findIndex(s => s.wx_id === wxId);
    const prev = idx >= 0 ? this.sessions[idx] : null;
    const row = {
      wx_id: wxId, nickname,
      preset_type: presetType, preset_command: presetCommand,
      preset_dir: presetDir, tts_voice: ttsVoice, last_active: lastActive,
      // COALESCE: only overwrite existing token if new one is provided
      context_token: contextToken ?? prev?.context_token ?? null,
    };
    if (idx >= 0) this.sessions[idx] = row;
    else this.sessions.push(row);
  }

  getSessions() {
    return [...this.sessions];
  }
}

module.exports = { MemoryAdapter };
