import "../tokens.css";

// Placeholder until the scenes land. Contract: render the frame for `t` seconds and nothing else.
export function Film({ t }: { t: number }) {
  return <div data-film-t={t.toFixed(3)} style={{ position: "fixed", inset: 0, background: "var(--void)" }} />;
}
