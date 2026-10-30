// Real-world terrain: heightmaps produced by tools/build_route.py, served from /worlds.
import { loadTrees, type TreeData } from "./forest";

export interface Grid {
  cols: number;
  rows: number;
  /** World position of the first sample (north-west corner). Rows go south (+z), columns east (+x). */
  x0: number;
  z0: number;
  spacing: number;
  /** Row spacing when it differs from the column spacing (a grid square in degrees is not square in metres). */
  spacingZ?: number;
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
  /** Optional fine grid right around the road, at the source resolution. */
  band?: Grid;
  /** Close-up surface patches cut from the imagery at its highest zoom, `metres` wide. */
  details?: { rock: ImageBitmap; scrub: ImageBitmap; metres: number };
  /** Stretches of the route with houses along it (metres along the route, storeys). */
  urban?: { from: number; to: number; floors: [number, number] }[];
  /** Where the local frame's origin lies, for the sun's position. */
  origin?: { lat: number; lon: number };
}

interface GridMeta {
  file: string;
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  spacing: number;
  /** Samples are float32 unless said otherwise; "int16" is whole metres. */
  format?: "int16";
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
  const buffer = await res.arrayBuffer();
  const data = meta.format === "int16" ? Float32Array.from(new Int16Array(buffer)) : new Float32Array(buffer);
  if (data.length !== meta.cols * meta.rows) throw new Error(`${meta.file}: ${data.length} samples, expected ${meta.cols * meta.rows}`);
  const o = meta.ortho;
  const grid: Grid = { cols: meta.cols, rows: meta.rows, x0: meta.x0, z0: meta.z0, spacing: meta.spacing, data };
  if (o) {
    const images = await Promise.all(o.files.map((row) => Promise.all(row.map(loadImage))));
    grid.ortho = { rowEdges: o.rowEdges, colEdges: o.colEdges, size: o.size, images };
  }
  return grid;
}

/** A world that streams terrain tiles around a road network (see streaming.ts). */
export interface NetworkWorldData {
  id: string;
  name: string;
  attribution: string;
  origin: { lat: number; lon: number };
  far: Grid;
  /** A finer height grid over the roads' region (45 m), for mid-distance blocks between the tiles and the far layer. */
  mid: Grid | null;
  tiles: { dlat: number; dlon: number; dem: string; ortho: string; orthoZoom: number };
  map: { image: ImageBitmap; lat_min: number; lat_max: number; lon_min: number; lon_max: number } | null;
  details?: { rock: ImageBitmap; scrub: ImageBitmap; metres: number };
  /** Real tree positions and heights from a canopy height model (tools/build_trees.py). */
  trees?: TreeData | null;
}

export async function loadNetworkWorld(id: string): Promise<NetworkWorldData> {
  const res = await fetch(`/worlds/${id}.json`);
  if (!res.ok) throw new Error(`world ${id}: ${res.status}`);
  const meta = (await res.json()) as {
    id: string;
    name: string;
    attribution: string;
    origin: { lat: number; lon: number };
    far: GridMeta;
    mid?: GridMeta;
    tiles: NetworkWorldData["tiles"];
    map: { file: string; lat_min: number; lat_max: number; lon_min: number; lon_max: number } | null;
    details?: { rock: string; scrub: string; metres: number };
    trees?: string;
  };
  // Close-up patches: this world's own, or the ones cut for Sa Calobra, which is the same limestone.
  const details = meta.details ?? { rock: "/worlds/sa-calobra/detail-rock.jpg", scrub: "/worlds/sa-calobra/detail-scrub.jpg", metres: 110 };
  const [far, mid, mapImage, rock, scrub, trees] = await Promise.all([
    loadGrid(meta.far),
    meta.mid ? loadGrid(meta.mid).catch((e) => (console.warn(`mid layer: ${e}`), null)) : Promise.resolve(null),
    meta.map ? loadImage(meta.map.file) : Promise.resolve(null),
    loadImage(details.rock).catch(() => null),
    loadImage(details.scrub).catch(() => null),
    meta.trees ? loadTrees(meta.trees).catch((e) => (console.warn(`trees: ${e}`), null)) : Promise.resolve(null),
  ]);
  return {
    id: meta.id,
    name: meta.name,
    attribution: meta.attribution,
    origin: meta.origin,
    far,
    mid,
    tiles: meta.tiles,
    map: meta.map && mapImage ? { image: mapImage, ...meta.map } : null,
    details: rock && scrub ? { rock, scrub, metres: details.metres } : undefined,
    trees,
  };
}

/** Mean RGB of an image in 0..1, through a small canvas. */
export function imageMean(img: ImageBitmap): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    sum[0] += d[i];
    sum[1] += d[i + 1];
    sum[2] += d[i + 2];
  }
  const n = (d.length / 4) * 255;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
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
  const meta = (await res.json()) as {
    id: string;
    name: string;
    attribution: string;
    near: GridMeta;
    far: GridMeta;
    band?: GridMeta;
    details?: { rock: string; scrub: string; metres: number };
    urban?: WorldData["urban"];
    origin?: { lat: number; lon: number };
  };
  const [near, far, band, rock, scrub] = await Promise.all([
    loadGrid(meta.near),
    loadGrid(meta.far),
    meta.band ? loadGrid(meta.band) : undefined,
    meta.details ? loadImage(meta.details.rock) : undefined,
    meta.details ? loadImage(meta.details.scrub) : undefined,
  ]);
  const details = meta.details && rock && scrub ? { rock, scrub, metres: meta.details.metres } : undefined;
  return { id: meta.id, name: meta.name, attribution: meta.attribution, near, far, band, details, urban: meta.urban, origin: meta.origin };
}

/** Bilinear height, or null outside the grid. */
export function gridSample(g: Grid, x: number, z: number): number | null {
  const fx = (x - g.x0) / g.spacing;
  const fz = (z - g.z0) / (g.spacingZ ?? g.spacing);
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
  const ez = g.spacingZ ?? g.spacing;
  const a = gridSample(g, x - e, z);
  const b = gridSample(g, x + e, z);
  const c = gridSample(g, x, z - ez);
  const d = gridSample(g, x, z + ez);
  if (a === null || b === null || c === null || d === null) return 0;
  return Math.hypot((b - a) / (2 * e), (d - c) / (2 * ez));
}
