// Real-world terrain: heightmaps produced by tools/build_route.py, served from /worlds.

export interface Grid {
  cols: number;
  rows: number;
  /** World position of the first sample (north-west corner). Rows go south (+z), columns east (+x). */
  x0: number;
  z0: number;
  spacing: number;
  data: Float32Array;
  /** Aerial imagery, one image per block of the grid between the given vertex-index edges. */
  ortho?: Ortho;
}

export interface Ortho {
  rowEdges: number[];
  colEdges: number[];
  size: number;
  images: ImageBitmap[][];
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
  ortho?: { rowEdges: number[]; colEdges: number[]; size: number; files: string[][] };
}

async function loadImage(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob(), { colorSpaceConversion: "none" });
}

async function loadGrid(meta: GridMeta): Promise<Grid> {
  const res = await fetch(meta.file);
  if (!res.ok) throw new Error(`${meta.file}: ${res.status}`);
  const data = new Float32Array(await res.arrayBuffer());
  if (data.length !== meta.cols * meta.rows) throw new Error(`${meta.file}: ${data.length} samples, expected ${meta.cols * meta.rows}`);
  const { ortho: o, ...rest } = meta;
  const grid: Grid = { ...rest, data };
  if (o) {
    const images = await Promise.all(o.files.map((row) => Promise.all(row.map(loadImage))));
    grid.ortho = { rowEdges: o.rowEdges, colEdges: o.colEdges, size: o.size, images };
  }
  return grid;
}

/** Reads colours out of a grid's imagery at world positions, through small sampling canvases. */
export class OrthoSampler {
  private pixels: { data: Uint8ClampedArray; size: number }[][] = [];
  constructor(
    private g: Grid,
    private o: Ortho,
    sampleSize = 512,
  ) {
    this.pixels = o.images.map((row) =>
      row.map((img) => {
        const c = document.createElement("canvas");
        c.width = c.height = sampleSize;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        return { data: ctx.getImageData(0, 0, sampleSize, sampleSize).data, size: sampleSize };
      }),
    );
  }

  /** RGB in 0..1, or null outside the imagery. */
  colorAt(x: number, z: number): [number, number, number] | null {
    const g = this.g;
    const fx = (x - g.x0) / g.spacing;
    const fz = (z - g.z0) / g.spacing;
    const { rowEdges, colEdges } = this.o;
    if (fx < 0 || fz < 0 || fx > colEdges[colEdges.length - 1] || fz > rowEdges[rowEdges.length - 1]) return null;
    let br = 0;
    while (br < rowEdges.length - 2 && fz > rowEdges[br + 1]) br++;
    let bc = 0;
    while (bc < colEdges.length - 2 && fx > colEdges[bc + 1]) bc++;
    const { data, size } = this.pixels[br][bc];
    const u = (fx - colEdges[bc]) / (colEdges[bc + 1] - colEdges[bc]);
    const v = (fz - rowEdges[br]) / (rowEdges[br + 1] - rowEdges[br]);
    const px = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
    const py = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
    const i = (py * size + px) * 4;
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
  }
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
