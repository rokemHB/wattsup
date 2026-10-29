// A small road network for tests.
import type { RoadNetwork } from "./world/network";

/**
 * A square of four roads with a diagonal shortcut and a spur:
 *   0 ---- 1
 *   |  \   |
 *   |   \  |
 *   3 ---- 2 ---- 4
 * Edges: 0: 0→1 (100 m), 1: 1→2 (100 m), 2: 2→3 (100 m), 3: 3→0 (100 m), 4: 0→2 (diagonal, ~141 m), 5: 2→4 (spur, 100 m).
 */
export function square(): RoadNetwork {
  const nodes = [
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
    { x: 200, z: 100 },
  ];
  const links: [number, number][] = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [0, 2],
    [2, 4],
  ];
  const xyz: number[] = [];
  const edges = links.map(([a, b], k) => {
    const start = xyz.length / 3;
    const n = 11;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      xyz.push(nodes[a].x + (nodes[b].x - nodes[a].x) * t, k === 5 ? 10 * t : 0, nodes[a].z + (nodes[b].z - nodes[a].z) * t);
    }
    return { a, b, ref: `R${k}`, name: null, kind: 1, start, count: n, length_m: Math.hypot(nodes[b].x - nodes[a].x, nodes[b].z - nodes[a].z) };
  });
  return {
    name: "square",
    origin: { lat: 0, lon: 0 },
    nodes: nodes.map((n) => ({ ...n, y: 0, signs: null })),
    edges,
    places: [],
    points: xyz.length / 3,
    xyz: new Float32Array(xyz),
  };
}

