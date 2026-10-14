export type Position = { x: number; y: number };
export type Geometry = { x: number; y: number; width: number; height: number };
export type Layout = {
  shape: "circle" | "rect";
  geometry: Geometry;
  positions: Position[];
};
export const initialGeometry: Geometry = {
  x: 25,
  y: 25,
  width: 50,
  height: 50,
};
export function seats(
  count: number,
  shape: "circle" | "rect",
  g: Geometry,
): Position[] {
  return Array.from({ length: count }, (_, i) => {
    const a = i / count;
    if (shape === "circle")
      return {
        x: g.x + g.width / 2 + (g.width / 2 + 8) * Math.sin(a * Math.PI * 2),
        y: g.y + g.height / 2 - (g.height / 2 + 8) * Math.cos(a * Math.PI * 2),
      };
    const side = a * 4,
      w = g.width + 16,
      h = g.height + 16,
      x = g.x - 8,
      y = g.y - 8;
    if (side < 1) return { x: x + w * side, y };
    if (side < 2) return { x: x + w, y: y + h * (side - 1) };
    if (side < 3) return { x: x + w * (3 - side), y: y + h };
    return { x, y: y + h * (4 - side) };
  });
}
export function initialLayout(count: number, shape: "circle" | "rect"): Layout {
  return {
    shape,
    geometry: { ...initialGeometry },
    positions: seats(count, shape, initialGeometry),
  };
}
export function csv(
  rows: {
    name: string;
    speakingSeconds: number;
    turns: number;
    unknownSeconds?: number;
    confidence?: number;
  }[],
) {
  return [
    "name,speakingSeconds,turns,unknownSeconds,confidence",
    ...rows.map(
      (r) =>
        `"${r.name.replaceAll('"', '""')}",${r.speakingSeconds},${r.turns},${r.unknownSeconds ?? 0},${r.confidence ?? 0}`,
    ),
  ].join("\r\n");
}
