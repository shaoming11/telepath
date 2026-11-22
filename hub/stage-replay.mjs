// Ephemeral, stage-only copies: provider assets may be pruned after delivery.
export class StageReplay {
  constructor({ maxBytes = 32 * 1024 * 1024, maxClips = 200 } = {}) {
    this.maxBytes = maxBytes;
    this.maxClips = maxClips;
    this.clips = new Map();
    this.bytes = 0;
  }
  scope(sessionId) {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.clips.clear();
    this.bytes = 0;
  }
  add(sessionId, frame, seat, asset) {
    this.scope(sessionId);
    if (!frame.messageId || !frame.text || !asset?.buffer || asset.buffer.length > this.maxBytes) return;
    const previous = this.clips.get(frame.messageId);
    if (previous) this.bytes -= previous.asset.buffer.length;
    this.clips.delete(frame.messageId);
    this.clips.set(frame.messageId, {
      messageId: frame.messageId, seat, text: frame.text,
      url: '/stage-replay/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(frame.messageId),
      asset,
    });
    this.bytes += asset.buffer.length;
    while (this.bytes > this.maxBytes || this.clips.size > this.maxClips) {
      const [id, clip] = this.clips.entries().next().value;
      this.bytes -= clip.asset.buffer.length;
      this.clips.delete(id);
    }
  }
  snapshot(sessionId) {
    this.scope(sessionId);
    return [...this.clips.values()].map(({ asset, ...clip }) => clip);
  }
  get(path, sessionId) {
    this.scope(sessionId);
    return [...this.clips.values()].find(clip => decodeURIComponent(clip.url) === path)?.asset;
  }
}
