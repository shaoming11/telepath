// Placeholder. One shared stage connection to the hub through /hub (see vite.config.ts).
export type HubStatus = "offline" | "connecting" | "online";

export function useHub(): { status: HubStatus; state: unknown; send: (frame: object) => void } {
  return { status: "offline", state: null, send: () => {} };
}
