// Trees where the real ones stand: tree tops detected in a 1 m canopy height model
// (tools/build_trees.py; Meta/WRI High Resolution Canopy Height Maps, CC BY 4.0), each
// with its measured height. Per 400 m cell, one instanced mesh per kind; cells far
// from the rider are hidden (the aerial photo shows the forest there), cells at middle
// distance use a lighter model, and only near cells cast shadows.
import * as THREE from "three";
import { mulberry32 } from "./noise";
import { CANOPY_SHADE, foliageDepthMaterial, foliageMaterial, treeGeometry, type TreeKind } from "./trees";

export interface TreeData {
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  cell: number;
  offsets: Uint32Array;
  /** One u32 per tree: x and z (12 bits each, 0.1 m from the cell's corner), height (8 bits, 0.1 m). */
  recs: Uint32Array;
}

export function parseTrees(buf: ArrayBuffer): TreeData {
  const head = new DataView(buf, 0, 20);
  const cols = head.getUint32(0, true);
  const rows = head.getUint32(4, true);
  const offsets = new Uint32Array(buf, 20, cols * rows + 1);
  const start = 20 + 4 * (cols * rows + 1);
  return { cols, rows, x0: head.getFloat32(8, true), z0: head.getFloat32(12, true), cell: head.getFloat32(16, true), offsets, recs: new Uint32Array(buf, start, offsets[cols * rows]) };
}

/** Fetches and unpacks a gzip-compressed tree file. */
export async function loadTrees(url: string): Promise<TreeData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  // A server may already have unpacked it (Content-Encoding: gzip): only inflate a gzip stream.
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return parseTrees(buf);
  const raw = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return parseTrees(raw);
}

/** Cells nearer than this to the rider are shown. */
export const FOREST_RADIUS_M = 1000;
/** Beyond this, cells switch to the two-card model. */
const LITE_RADIUS_M = 320;
/** Only cells this close cast shadows (the sun's shadow box is ±110 m around the rider). */
const SHADOW_RADIUS_M = 260;

/** Kind codes in the data and the models they get. */
const KINDS: TreeKind[] = ["pine", "round"];
/** Model height and the share of the card width the painted crown fills, at size 1 (see trees.ts). */
const MODEL = { pine: { h: 9, crown: 0.8 * 9 }, round: { h: 6.5, crown: 0.86 * 7 } } as Record<TreeKind, { h: number; crown: number }>;
const PALETTE = {
  pine: ["#e2e8dc", "#d4dccc", "#eaeee2", "#c8d4be", "#dce4d0"],
  round: ["#e4ead8", "#d6dec8", "#ecf0e0"],
} as Record<TreeKind, string[]>;

/**
 * Crown width from height. Popescu & Wynne (2004) give 3.1 + 0.009 h² m for pines; Aleppo
 * pines and the island's olives and holm oaks spread wider, so it is at least 0.45 h (pine)
 * or 0.9 h (round crowns).
 */
function crownWidth(kind: TreeKind, h: number): number {
  return Math.max(3.1 + 0.009 * h * h, kind === "pine" ? 0.45 * h : 0.9 * h);
}

export interface ForestCell {
  cx: number;
  cz: number;
  half: number;
  /** Per kind the measured trees, and (near the rider only) the infill around them. */
  meshes: { mesh: THREE.InstancedMesh; full: THREE.BufferGeometry; lite: THREE.BufferGeometry; infill: boolean }[];
  state: { visible: boolean; lite: boolean; cast: boolean; infill: boolean };
}

/** Infill trees are shown this close to the rider only. */
const INFILL_RADIUS_M = 450;
/** Typical spacing of trees in a closed Aleppo pine or holm oak wood (300-400 a hectare). */
const CLOSED_SPACING_M = 5.5;
/** Neighbours are looked for this far; a lone tree counts as having its nearest neighbour here. */
const NEIGHBOUR_M = 16;

/** The cell indices whose centre lies inside the box (each cell belongs to exactly one tile). */
export function cellsIn(d: TreeData, x0: number, z0: number, x1: number, z1: number): number[] {
  const out: number[] = [];
  const c0 = Math.max(0, Math.floor((x0 - d.x0) / d.cell));
  const c1 = Math.min(d.cols - 1, Math.floor((x1 - d.x0) / d.cell));
  const r0 = Math.max(0, Math.floor((z0 - d.z0) / d.cell));
  const r1 = Math.min(d.rows - 1, Math.floor((z1 - d.z0) / d.cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cx = d.x0 + (c + 0.5) * d.cell;
      const cz = d.z0 + (r + 0.5) * d.cell;
      if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
      const i = r * d.cols + c;
      if (d.offsets[i + 1] > d.offsets[i]) out.push(i);
    }
  }
  return out;
}

/**
 * Builds one cell's trees. `ground(x, z)` is the terrain height; `clear(x, z)` says
 * whether a tree may stand there (not on a road, not in the sea).
 */
export function buildCell(d: TreeData, idx: number, ground: (x: number, z: number) => number, clear: (x: number, z: number) => boolean): ForestCell | null {
  const a = d.offsets[idx];
  const b = d.offsets[idx + 1];
  const cx0 = d.x0 + (idx % d.cols) * d.cell;
  const cz0 = d.z0 + Math.floor(idx / d.cols) * d.cell;
  const rand = mulberry32(idx * 7919 + 13);
  const byKind: { x: number; z: number; h: number }[][] = KINDS.map(() => []);
  for (let i = a; i < b; i++) {
    const r = d.recs[i];
    const x = cx0 + (r & 0xfff) / 10;
    const z = cz0 + ((r >>> 12) & 0xfff) / 10;
    const h = (r >>> 24) / 10;
    // Below 7 m: olive, carob, holm oak (round crowns); above: pines.
    const k = h < 7 ? 1 : 0;
    if (!clear(x, z)) continue;
    byKind[k].push({ x, z, h });
  }
  // The canopy model is smoother than its pixels: in a closed wood neighbouring crowns merge
  // into one top, so ~50 tops a hectare stand for 300-600 trees (checked against the
  // orthophoto). Each top's distance to its nearest neighbour is the crown space it stands
  // for: its crown grows into part of it, and infill trees (smaller, near the rider only)
  // take the rest, so a closed canopy reads closed and an open one stays open.
  const all = byKind.flatMap((list, k) => list.map((t) => ({ ...t, k })));
  const bucket = new Map<number, number[]>();
  const key = (x: number, z: number) => Math.floor(x / NEIGHBOUR_M) * 100003 + Math.floor(z / NEIGHBOUR_M);
  all.forEach((t, i) => {
    const kk = key(t.x, t.z);
    const list = bucket.get(kk);
    if (list) list.push(i);
    else bucket.set(kk, [i]);
  });
  const nearest = all.map((t, i) => {
    let best = NEIGHBOUR_M;
    const bx = Math.floor(t.x / NEIGHBOUR_M);
    const bz = Math.floor(t.z / NEIGHBOUR_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const j of bucket.get((bx + dx) * 100003 + bz + dz) ?? []) {
          if (j !== i) best = Math.min(best, Math.hypot(all[j].x - t.x, all[j].z - t.z));
        }
      }
    }
    return best;
  });
  const placed: { x: number; z: number; h: number; k: number; crown: number; infill: boolean }[] = [];
  all.forEach((t, i) => {
    const kind = KINDS[t.k];
    const allo = crownWidth(kind, t.h);
    const nn = nearest[i];
    placed.push({ ...t, crown: Math.max(allo, Math.min(0.6 * nn, 1.6 * allo)), infill: false });
    const extra = Math.min(6, Math.max(0, Math.round((nn / CLOSED_SPACING_M) ** 2 - 1)));
    for (let e = 0; e < extra; e++) {
      const ang = rand() * Math.PI * 2;
      const rad = (0.25 + 0.25 * Math.sqrt(rand())) * nn;
      const x = t.x + Math.cos(ang) * rad;
      const z = t.z + Math.sin(ang) * rad;
      if (!clear(x, z)) continue;
      const h = t.h * (0.6 + 0.35 * rand());
      const k = h < 7 ? 1 : 0;
      placed.push({ x, z, h, k, crown: crownWidth(KINDS[k], h), infill: true });
    }
  });
  const m = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const col = new THREE.Color();
  const meshes: ForestCell["meshes"] = [];
  for (const infill of [false, true]) {
    KINDS.forEach((kind, k) => {
      const trees = placed.filter((t) => t.k === k && t.infill === infill);
      if (!trees.length) return;
      const full = treeGeometry(kind);
      const lite = treeGeometry(kind, true);
      const mesh = new THREE.InstancedMesh(lite, foliageMaterial(), trees.length);
      mesh.customDepthMaterial = foliageDepthMaterial();
      const model = MODEL[kind];
      const palette = PALETTE[kind];
      trees.forEach((t, i) => {
        const sxz = t.crown / model.crown;
        quat.setFromAxisAngle(up, rand() * Math.PI * 2);
        m.compose(pos.set(t.x, ground(t.x, t.z) - 0.15, t.z), quat, scale.set(sxz, t.h / model.h, sxz));
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, col.set(palette[Math.floor(rand() * palette.length)]).offsetHSL(0, 0, (rand() - 0.5) * 0.08).multiplyScalar(CANOPY_SHADE));
      });
      mesh.computeBoundingSphere();
      mesh.visible = false;
      meshes.push({ mesh, full, lite, infill });
    });
  }
  if (!meshes.length) return null;
  return { cx: cx0 + d.cell / 2, cz: cz0 + d.cell / 2, half: d.cell / 2, meshes, state: { visible: false, lite: true, cast: false, infill: false } };
}

/** Shows, hides and swaps the level of detail of a cell for the rider at (x, z). */
export function updateCell(c: ForestCell, x: number, z: number) {
  // Distance to the cell's nearest edge, not its centre: a cell the rider is in is at 0.
  const dx = Math.max(0, Math.abs(c.cx - x) - c.half);
  const dz = Math.max(0, Math.abs(c.cz - z) - c.half);
  const d = Math.hypot(dx, dz);
  const visible = d < FOREST_RADIUS_M;
  const lite = d > LITE_RADIUS_M;
  const cast = d < SHADOW_RADIUS_M;
  const infill = d < INFILL_RADIUS_M;
  const s = c.state;
  if (s.visible === visible && s.lite === lite && s.cast === cast && s.infill === infill) return;
  s.visible = visible;
  s.lite = lite;
  s.cast = cast;
  s.infill = infill;
  for (const m of c.meshes) {
    m.mesh.visible = visible && (!m.infill || infill);
    m.mesh.geometry = lite ? m.lite : m.full;
    m.mesh.castShadow = cast;
  }
}

/** Time a frame may spend building cells for a single route. */
const ROUTE_BUILD_MS = 4;

/**
 * Real trees along a single route (a built-in route's world, not the network): the
 * route's terrain is one static mesh, so the cells within reach of the rider are built a
 * few a frame as the rider comes near and dropped well behind, instead of all at load
 * (Málaga's 43 km hold 190 000 trees).
 */
export class RouteForest {
  readonly group = new THREE.Group();
  private cells = new Map<number, ForestCell | null>();

  constructor(
    private d: TreeData,
    private ground: (x: number, z: number) => number,
    private clear: (x: number, z: number) => boolean,
  ) {}

  update(x: number, z: number) {
    const reach = FOREST_RADIUS_M + this.d.cell;
    const started = performance.now();
    for (const idx of cellsIn(this.d, x - reach, z - reach, x + reach, z + reach)) {
      if (this.cells.has(idx)) continue;
      if (performance.now() - started > ROUTE_BUILD_MS) break;
      const cell = buildCell(this.d, idx, this.ground, this.clear);
      this.cells.set(idx, cell);
      if (cell) for (const m of cell.meshes) this.group.add(m.mesh);
    }
    for (const [idx, cell] of this.cells) {
      const cx = this.d.x0 + ((idx % this.d.cols) + 0.5) * this.d.cell;
      const cz = this.d.z0 + (Math.floor(idx / this.d.cols) + 0.5) * this.d.cell;
      if (Math.hypot(cx - x, cz - z) > reach + 2 * this.d.cell) {
        // Instance buffers are only freed by dispose(); the tree geometries are shared.
        for (const m of cell?.meshes ?? []) {
          this.group.remove(m.mesh);
          m.mesh.dispose();
        }
        this.cells.delete(idx);
      } else if (cell) {
        updateCell(cell, x, z);
      }
    }
  }
}
