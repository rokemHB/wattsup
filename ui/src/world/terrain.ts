// Real-world terrain: heightmaps produced by tools/build_route.py, served from /worlds.

export interface Grid {
  cols: number;
  rows: number;
  /** World position of the first sample (north-west corner). Rows go south (+z), columns east (+x). */
  x0: number;
  z0: number;
  spacing: number;
  data: Float32Array;
}

export interface WorldData {
  id: string;
  name: string;
  attribution: string;
  near: Grid;
  far: Grid;
}

interface GridMeta {
  file: string;
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  spacing: number;
}

async function loadGrid(meta: GridMeta): Promise<Grid> {
  const res = await fetch(meta.file);
  if (!res.ok) throw new Error(`${meta.file}: ${res.status}`);
  const data = new Float32Array(await res.arrayBuffer());
  if (data.length !== meta.cols * meta.rows) throw new Error(`${meta.file}: ${data.length} samples, expected ${meta.cols * meta.rows}`);
  return { ...meta, data };
}

export async function loadWorld(id: string): Promise<WorldData> {
  const res = await fetch(`/worlds/${id}.json`);
  if (!res.ok) throw new Error(`world ${id}: ${res.status}`);
  const meta = (await res.json()) as { id: string; name: string; attribution: string; near: GridMeta; far: GridMeta };
  const [near, far] = await Promise.all([loadGrid(meta.near), loadGrid(meta.far)]);
  return { id: meta.id, name: meta.name, attribution: meta.attribution, near, far };
}

/** Bilinear height, or null outside the grid. */
export function gridSample(g: Grid, x: number, z: number): number | null {
  const fx = (x - g.x0) / g.spacing;
  const fz = (z - g.z0) / g.spacing;
  if (fx < 0 || fz < 0 || fx > g.cols - 1 || fz > g.rows - 1) return null;
  const ix = Math.min(Math.floor(fx), g.cols - 2);
  const iz = Math.min(Math.floor(fz), g.rows - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const d = g.data;
  const i = iz * g.cols + ix;
  const top = d[i] * (1 - tx) + d[i + 1] * tx;
  const bottom = d[i + g.cols] * (1 - tx) + d[i + g.cols + 1] * tx;
  return top * (1 - tz) + bottom * tz;
}

/** Magnitude of the terrain gradient (rise over run) from the grid. */
export function gridSlope(g: Grid, x: number, z: number): number {
  const e = g.spacing;
  const a = gridSample(g, x - e, z);
  const b = gridSample(g, x + e, z);
  const c = gridSample(g, x, z - e);
  const d = gridSample(g, x, z + e);
  if (a === null || b === null || c === null || d === null) return 0;
  return Math.hypot((b - a) / (2 * e), (d - c) / (2 * e));
}
