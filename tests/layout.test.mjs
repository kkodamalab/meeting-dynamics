import test from "node:test";
import assert from "node:assert/strict";
import { initialLayout, seats, csv } from "../src/layout.ts";
for (const shape of ["circle", "rect"])
  for (const count of [2, 3, 5, 10])
    test(`${shape}: ${count} evenly spaced seats and square initial bounds`, () => {
      const l = initialLayout(count, shape);
      assert.equal(l.geometry.width, l.geometry.height);
      assert.equal(l.positions.length, count);
      assert.equal(
        new Set(l.positions.map((p) => `${p.x},${p.y}`)).size,
        count,
      );
      if (shape === "circle")
        for (const p of l.positions)
          assert.ok(Math.abs(Math.hypot(p.x - 50, p.y - 50) - 33) < 1e-10);
      else
        for (const p of l.positions)
          assert.ok(p.x === 17 || p.x === 83 || p.y === 17 || p.y === 83);
    });
test("reshaping recomputes a proportional perimeter", () => {
  const p = seats(4, "circle", { x: 20, y: 20, width: 60, height: 40 });
  assert.deepEqual(p[0], { x: 50, y: 12 });
  assert.equal(p[1].x, 88);
});
test("CSV preserves comma, quotes and newline in participant name", () =>
  assert.equal(
    csv([{ name: 'A,"B"\nC', speakingSeconds: 1.2, turns: 2 }]),
    'name,speakingSeconds,turns,unknownSeconds,confidence\r\n"A,""B""\nC",1.2,2,0,0',
  ));
