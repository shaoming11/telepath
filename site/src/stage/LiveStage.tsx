// Placeholder. The rebuilt stage (Lobby, Live board, Reveal, Operator) replaces this.
export function LiveStage({ embedded = false }: { embedded?: boolean }) {
  return <section data-stage data-embedded={embedded} />;
}
