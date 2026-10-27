// Pure geometry along a route, kept apart from three.js so it is unit-tested.
import type { Route } from "../types";

export interface Pose {
  x: number;
  y: number;
  z: number;
  /** Unit direction of travel on the ground. */
  dx: number;
  dz: number;
  /** Road grade in percent at this point (from the sampled elevation). */
  grade: number;
}

export class RouteSampler {
  readonly length: number;
  readonly spacing: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(readonly route: Route) {
    const pts = route.points;
    this.length = pts.length ? pts[pts.length - 1].distance_m : 0;
    this.spacing = pts.length > 1 ? pts[1].distance_m : 1;
    this.minY = Math.min(...pts.map((p) => p.y));
    this.maxY = Math.max(...pts.map((p) => p.y));
  }

  /** Distance within the current lap. */
  wrap(distance: number): number {
    if (this.length <= 0) return 0;
    if (!this.route.closed) return Math.min(Math.max(distance, 0), this.length);
    return ((distance % this.length) + this.length) % this.length;
  }

  private index(distance: number): [number, number] {
    const pts = this.route.points;
    const raw = this.wrap(distance) / this.spacing;
    const i = Math.min(Math.floor(raw), pts.length - 2);
    return [i, Math.min(Math.max(raw - i, 0), 1)];
  }

  pose(distance: number): Pose {
    const pts = this.route.points;
    const [i, t] = this.index(distance);
    const a = pts[i];
    const b = pts[i + 1];
    // Direction from neighbours one sample out, so corners stay smooth.
    const prev = pts[i === 0 ? (this.route.closed ? pts.length - 2 : 0) : i - 1];
    const next = pts[i + 2 < pts.length ? i + 2 : this.route.closed ? 1 : pts.length - 1];
    const dirA = norm(b.x - prev.x, b.z - prev.z);
    const dirB = norm(next.x - a.x, next.z - a.z);
    const d = norm(dirA[0] + (dirB[0] - dirA[0]) * t, dirA[1] + (dirB[1] - dirA[1]) * t);
    const rise = b.y - a.y;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + rise * t,
      z: a.z + (b.z - a.z) * t,
      dx: d[0],
      dz: d[1],
      grade: (rise / this.spacing) * 100,
    };
  }

  /** Elevation profile resampled to `n` columns, 0..1 of the height range. */
  profile(n: number): number[] {
    const span = this.maxY - this.minY || 1;
    return Array.from({ length: n }, (_, k) => (this.pose((k / (n - 1)) * this.length).y - this.minY) / span);
  }
}

function norm(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}
