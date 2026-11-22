export const AIRPODS_PRO_ID = 'pro';

const SIGNALS = Object.freeze({ pause: 'R1', play: 'R1', nexttrack: 'R2', previoustrack: 'L1' });
export const PRO_CHECKS = Object.freeze({
  pause: { label: 'Single squeeze', hint: 'single squeeze either stem' },
  nexttrack: { label: 'Double squeeze', hint: 'double squeeze either stem' },
  previoustrack: { label: 'Triple squeeze', hint: 'triple squeeze either stem' },
});

export function proCheckAction(action) {
  return action === 'play' ? 'pause' : action;
}

export function createAirPodsProInput({ onRaw, onSignal, onPlay, now }) {
  return {
    receive(action) {
      if (!Object.hasOwn(SIGNALS, action)) return;
      const event = { action, at: now(), squeeze: true };
      onRaw?.(event);
      if (action === 'play') onPlay?.();
      onSignal?.(SIGNALS[action], [event]);
    },
  };
}
