/** Positions share a visual centre; every knowledge level uses the same orbit. */
export function orbitPosition(index: number, total: number) {
  const radius = Math.max(310, total * 32);
  const angle = index * Math.PI * 2 / Math.max(1, total) - Math.PI / 2;
  return { x: Math.cos(angle) * radius - 90, y: Math.sin(angle) * radius * .85 - 20 };
}
export const corePosition = { x: -90, y: -54 };
