export const ANNOUNCEMENT_MAX_LENGTH = 140;

export const OPERATOR_ANNOUNCEMENTS = Object.freeze([
  { id: 'sound-check', label: 'Sound check', text: 'Sound check. Can you hear me?' },
  { id: 'time-cue', label: 'Thirty seconds left', text: 'Thirty seconds left.' },
  { id: 'reveal-cue', label: 'Bring up the reveal', text: 'Time to bring up the reveal.' },
]);

export function announcementText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, ANNOUNCEMENT_MAX_LENGTH) : '';
}
