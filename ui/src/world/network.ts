// The road network of a world in the renderer: geometry for roads and
// corridors, a spatial index for "nearest road point", and the junctions.
import { api } from "../api";
import type { NetworkEdge, NetworkInfo, NetworkNode } from "../types";

export interface RoadNetwork extends NetworkInfo {
  /** x, y, z per point. */
  xyz: Float32Array;
}

export async function loadNetwork(world: string): Promise<RoadNetwork | null> {
  const info = await api.networkInfo(world);
  if (!info) return null;
  const xyz = await api.networkPoints(world);
  return { ...info, xyz };
}

export interface Near {
  d: number;
  y: number;
  /** Global point index. */
  i: number;
  edge: number;
}

/** Road points bucketed on a coarse grid, for nearest-point queries. */
export class NetworkIndex {
  private cells = new Map<number, number[]>();
  private cell = 60;
  private edgeOf: Int32Array;

  constructor(readonly net: RoadNetwork) {
    const n = net.points;
    this.edgeOf = new Int32Array(n);
    net.edges.forEach((e, ei) => {
      for (let i = e.start; i < e.start + e.count; i++) this.edgeOf[i] = ei;
    });
    for (let i = 0; i < n; i++) {
      const key = this.key(net.xyz[i * 3], net.xyz[i * 3 + 2]);
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }

  private key(x: number, z: number) {
    // Pack two 20-bit cell coordinates; the island spans far fewer cells than that.
    return (Math.floor(x / this.cell) + 500000) * 1048576 + (Math.floor(z / this.cell) + 500000);
  }

  nearest(x: number, z: number, radius: number): Near {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = Infinity;
    let bi = -1;
    const xyz = this.net.xyz;
    for (let i = -r; i <= r; i++) {
      for (let k = -r; k <= r; k++) {
        const list = this.cells.get((cx + i + 500000) * 1048576 + (cz + k + 500000));
        if (!list) continue;
        for (const idx of list) {
          const dx = xyz[idx * 3] - x;
          const dz = xyz[idx * 3 + 2] - z;
          const d = dx * dx + dz * dz;
          if (d < best) {
            best = d;
            bi = idx;
          }
        }
      }
    }
    return bi < 0 ? { d: Infinity, y: 0, i: -1, edge: -1 } : { d: Math.sqrt(best), y: xyz[bi * 3 + 1], i: bi, edge: this.edgeOf[bi] };
  }

  /** Edges with at least one point inside the box (expanded by `margin`). */
  edgesIn(x0: number, z0: number, x1: number, z1: number, margin = 0): number[] {
    const out = new Set<number>();
    const xyz = this.net.xyz;
    this.net.edges.forEach((e, ei) => {
      for (let i = e.start; i < e.start + e.count; i += 3) {
        const x = xyz[i * 3];
        const z = xyz[i * 3 + 2];
        if (x >= x0 - margin && x <= x1 + margin && z >= z0 - margin && z <= z1 + margin) {
          out.add(ei);
          break;
        }
      }
    });
    return [...out];
  }

  /** An edge's points as route-like objects (distance, x, y, z). */
  polyline(edge: number): { distance_m: number; x: number; y: number; z: number }[] {
    const e = this.net.edges[edge];
    const xyz = this.net.xyz;
    const out = [];
    let d = 0;
    for (let i = e.start; i < e.start + e.count; i++) {
      const x = xyz[i * 3];
      const y = xyz[i * 3 + 1];
      const z = xyz[i * 3 + 2];
      if (out.length) {
        const p = out[out.length - 1];
        d += Math.hypot(x - p.x, z - p.z);
      }
      out.push({ distance_m: d, x, y, z });
    }
    return out;
  }

  edge(i: number): NetworkEdge {
    return this.net.edges[i];
  }

  node(i: number): NetworkNode {
    return this.net.nodes[i];
  }
}
