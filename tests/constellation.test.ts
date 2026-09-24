import assert from 'node:assert/strict';
import test from 'node:test';
import { orbitPosition, corePosition } from '../frontend/src/constellation-layout.js';

test('all paginated children stay clear of the core and each other', () => {
  for (const total of [1, 2, 6, 10, 12, 24]) {
    const nodes = Array.from({ length: total }, (_, i) => orbitPosition(i, total));
    for (const [index, node] of nodes.entries()) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
      assert.ok(Math.hypot(node.x - corePosition.x, node.y - corePosition.y) > 180);
      for (const other of nodes.slice(index + 1)) {
        assert.ok(Math.abs(node.x - other.x) >= 180 || Math.abs(node.y - other.y) >= 100, '180 × 100 satellite hit areas must not overlap');
      }
    }
  }
});
