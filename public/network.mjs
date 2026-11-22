import { seededRandom } from './input.mjs';

export const DEFAULT_NETWORK = Object.freeze({
  enabled: false,
  delayMs: 38,
  jitterMs: 27,
  dropRate: 0.04,
  retryMs: 115,
  maxRetries: 4,
  seed: 9151,
});

export function createNetworkLink(socket, settings = {}) {
  const config = { ...DEFAULT_NETWORK, ...settings };
  const random = settings.random ?? seededRandom(config.seed);
  const now = settings.now ?? (() => performance.now());
  const set_timer = settings.setTimer ?? setTimeout;
  const clear_timer = settings.clearTimer ?? clearTimeout;
  const handlers = new Set();
  const timers = new Set();
  const next_delivery = { inbound: 0, outbound: 0 };
  const stats = { attempts: 0, dropped: 0, retried: 0, delivered: 0, lost: 0 };
  let closed = false;

  function transit(direction, send) {
    if (closed) return false;
    if (!config.enabled) {
      stats.attempts += 1;
      stats.delivered += 1;
      send();
      return true;
    }
    let offset_ms = Math.max(0, config.delayMs + (2 * random() - 1) * config.jitterMs);
    for (let retry = 0;; retry += 1) {
      stats.attempts += 1;
      if (random() >= config.dropRate) break;
      stats.dropped += 1;
      if (retry >= config.maxRetries) {
        stats.lost += 1;
        return false;
      }
      stats.retried += 1;
      offset_ms += config.retryMs;
    }
    const stamp = now();
    const due = Math.max(next_delivery[direction], stamp + offset_ms);
    next_delivery[direction] = due;
    const timer = set_timer(() => {
      timers.delete(timer);
      if (closed) return;
      stats.delivered += 1;
      send();
    }, Math.max(0, due - stamp));
    timers.add(timer);
    return true;
  }

  function receive(event) {
    let frame;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    transit('inbound', () => handlers.forEach(handler => handler(frame)));
  }

  function release() {
    closed = true;
    for (const timer of timers) clear_timer(timer);
    timers.clear();
    handlers.clear();
    socket.removeEventListener('message', receive);
    socket.removeEventListener('close', release);
  }

  socket.addEventListener('message', receive);
  socket.addEventListener('close', release);
  return {
    send(frame) {
      if (socket.readyState !== 1) return false;
      return transit('outbound', () => {
        if (socket.readyState === 1) socket.send(JSON.stringify(frame));
      });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() { release(); socket.close(); },
    stats,
  };
}
