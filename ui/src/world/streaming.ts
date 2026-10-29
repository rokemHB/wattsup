// A world the size of an island: terrain tiles fetched on demand around the
// rider (elevation from the IGN coverage service, imagery from the IGN
// WMTS, both through the app's disk cache), the road network's roads,
// corridors, parapets, trees and signs built per tile, and a static far layer.
import * as THREE from "three";
import { api } from "../api";
import { NetworkIndex, type RoadNetwork } from "./network";
import {
  CORRIDOR_BLEND_M,
  CORRIDOR_REACH,
  corridorHeight,
  corridorMesh,
  CUT_SLOPE,
  type Detail,
  gridBlockMesh,
  imageTexture,
  type Land,
  lerp,
  mergeByKind,
  parapets,
  ROAD_CLASS,
  roadMeshes,
  SEA_LEVEL,
  SHOULDER,
  smoothstep,
  TUNNEL_HALF,
  tunnelMesh,
  vegetation,
} from "./scene";
import { confirmationPost, faceCamera, signPost, type SignPost } from "./signs";

const cls_width = (kind: number) => ROAD_CLASS[Math.min(ROAD_CLASS.length - 1, kind)].width;
import { gridSample, gridSlope, type Grid } from "./terrain";
import { parseGeoTiff } from "./tiff";
import { asphaltTexture } from "./textures";
import { RouteSampler } from "./route";

const EARTH_LAT_M = 110574;
const EARTH_LON_M = 111320;
const WMTS_TILE = 256;

export interface TileScheme {
  dlat: number;
  dlon: number;
  dem: string;
  ortho: string;
  orthoZoom: number;
}

export interface NetworkWorldMeta {
  id: string;
  name: string;
  origin: { lat: number; lon: number };
  tiles: TileScheme;
  attribution: string;
}

/** Local metres <-> degrees, as the pipeline defines them. */
/** Ground this far above a tunnel's road is high enough to stay: the tube (5.8 m) plus a margin. */
const TUBE_CLEAR_M = 8;

export class Frame {
  readonly kx: number;
  constructor(readonly lat0: number, readonly lon0: number) {
    this.kx = EARTH_LON_M * Math.cos((lat0 * Math.PI) / 180);
  }
  toXZ(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * EARTH_LAT_M];
  }
  toLatLon(x: number, z: number): [number, number] {
    return [this.lat0 - z / EARTH_LAT_M, this.lon0 + x / this.kx];
  }
}

function mercator(lat: number, lon: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const phi = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
  return [x, y];
}

/** The terrain tiles a network world needs: every tile whose centre is within the load radius of a road. */
export function worldTiles(net: RoadNetwork, meta: NetworkWorldMeta): { i: number; j: number }[] {
  const frame = new Frame(meta.origin.lat, meta.origin.lon);
  const { dlat, dlon } = meta.tiles;
  const out = new Map<string, { i: number; j: number }>();
  for (let p = 0; p < net.points; p += 2) {
    const x = net.xyz[p * 3];
    const z = net.xyz[p * 3 + 2];
    const [lat, lon] = frame.toLatLon(x, z);
    const i0 = Math.floor(lat / dlat);
    const j0 = Math.floor(lon / dlon);
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      for (let j = j0 - 2; j <= j0 + 2; j++) {
        const key = `${i}_${j}`;
        if (out.has(key)) continue;
        const [cx, cz] = frame.toXZ((i + 0.5) * dlat, (j + 0.5) * dlon);
        if (Math.hypot(cx - x, cz - z) <= LOAD_RADIUS_M) out.set(key, { i, j });
      }
    }
  }
  return [...out.values()];
}

/** Every URL (elevation and imagery) behind a tile. */
export function tileUrls(meta: NetworkWorldMeta, i: number, j: number): string[] {
  const { dlat, dlon, dem, ortho, orthoZoom } = meta.tiles;
  const lat0 = i * dlat;
  const lat1 = (i + 1) * dlat;
  const lon0 = j * dlon;
  const lon1 = (j + 1) * dlon;
  const urls = [dem.replace("{lat0}", lat0.toFixed(5)).replace("{lat1}", lat1.toFixed(5)).replace("{lon0}", lon0.toFixed(5)).replace("{lon1}", lon1.toFixed(5))];
  const [mx0, my0] = mercator(lat1, lon0, orthoZoom);
  const [mx1, my1] = mercator(lat0, lon1, orthoZoom);
  for (let ty = Math.floor(my0); ty <= Math.floor(my1); ty++) {
    for (let tx = Math.floor(mx0); tx <= Math.floor(mx1); tx++) {
      urls.push(ortho.replace("{z}", String(orthoZoom)).replace("{x}", String(tx)).replace("{y}", String(ty)));
    }
  }
  return urls;
}

/** Rough size of a whole world's terrain, from typical tile sizes (elevation ~490 KB, an imagery tile ~17 KB). */
export function worldDownloadEstimate(net: RoadNetwork, meta: NetworkWorldMeta): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const t of worldTiles(net, meta)) {
    const n = tileUrls(meta, t.i, t.j).length;
    files += n;
    bytes += 490_000 + (n - 1) * 17_000;
  }
  return { files, bytes };
}

/**
 * Downloads a world's whole terrain into the disk cache, a few files at a
 * time, so rides work offline afterwards. Files already cached are quick.
 * Resolves with the number of files that could not be fetched.
 */
export async function prefetchWorld(net: RoadNetwork, meta: NetworkWorldMeta, onProgress: (done: number, total: number, bytes: number) => void, cancel: { cancelled: boolean }): Promise<number> {
  const urls = worldTiles(net, meta).flatMap((t) => tileUrls(meta, t.i, t.j));
  const seen = new Set<string>();
  const queue = urls.filter((u) => !seen.has(u) && seen.add(u));
  let done = 0;
  let bytes = 0;
  let failed = 0;
  const worker = async () => {
    while (queue.length && !cancel.cancelled) {
      const url = queue.shift()!;
      try {
        bytes += await api.cacheFetch(url);
      } catch (e) {
        failed++;
        console.warn(`prefetch ${url}: ${e}`);
      }
      done++;
      onProgress(done, seen.size, bytes);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return failed;
}

/** How much of a frame a tile build may take before it yields: the rest is for drawing. */
const BUILD_BUDGET_MS = 5;

/** Resolves on the next animation frame: long builds yield here so the picture keeps moving. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface Tile {
  key: string;
  i: number;
  j: number;
  /** Local bounds. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  grid: Grid | null;
  tex?: THREE.Texture;
  group: THREE.Group;
  posts: SignPost[];
  state: "loading" | "ready" | "failed";
  /** The ground meshes, and whether they are the coarse (20 m) version that far tiles start with. */
  ground: THREE.Mesh[];
  coarse: boolean;
  refining: boolean;
  /** Trees, bushes and rocks: only built once the tile is near, and casting shadows only nearer still. */
  veg: THREE.Group | null;
  photoColor: ((x: number, z: number) => [number, number, number] | null) | null;
}

/** Vegetation casts shadows only this close to the rider: the shadow pass redraws every caster. */
const SHADOW_RADIUS_M = 900;

/**
 * Sign posts farther than this from the rider are hidden: a town has dozens of
 * junctions, every board is its own draw call with its own texture, and the
 * lettering cannot be read from that far anyway.
 */
const SIGN_RADIUS_M = 400;

/** Tiles further than this from the rider get a 20 m ground; nearer ones the full 10 m. */
const DETAIL_RADIUS_M = 1300;

/** Load tiles whose centre is within this distance of the rider; drop them beyond the larger one. */
const LOAD_RADIUS_M = 2000;
const DROP_RADIUS_M = 3400;

/**
 * Mid-distance blocks: one per WMTS zoom-13 tile (about 3.8 km × 2.9 km here),
 * heights from the world's 45 m mid grid, imagery at zoom 14, kept within
 * these distances of the rider. They give the mountains their shape where
 * the tiles have not loaded (or never will, beyond 2 km).
 */
const MID_ZOOM = 13;
const MID_ORTHO_ZOOM = 14;
const MID_RADIUS_M = 7500;
const MID_DROP_M = 9500;
/** The far layer is lowered this much under a mid block, and both under a loaded tile. */
const SINK_UNDER_MID = 30;
const SINK_UNDER_TILE = 80;

interface MidBlock {
  key: string;
  box: { x0: number; z0: number; x1: number; z1: number };
  lat0: number;
  lat1: number;
  lon0: number;
  lon1: number;
  mesh: THREE.Mesh | null;
  base: Float32Array | null;
  state: "loading" | "ready" | "failed";
}

export class TileManager {
  private tiles = new Map<string, Tile>();
  private queue: Tile[] = [];
  private loading = 0;
  private frame: Frame;
  private index: NetworkIndex;
  private asphalt = asphaltTexture();
  private farBase = new Map<THREE.Mesh, Float32Array>();
  private mids = new Map<string, MidBlock>();
  private midLoading = 0;
  /** 1 where a road point lies in a tunnel (the camera stays in the tube there). */
  private inTunnel: Uint8Array;
  /** 1 where the ground is left as it is: inside a tunnel, but not its first and last 20 m, so the hillside is cut open to the portal. */
  private uncut: Uint8Array;
  /** 1 where the ground mesh gets a hole for the tube: the tunnel and the last metres of road into each portal. */
  private tubeZone: Uint8Array;

  constructor(
    private scene: THREE.Group,
    private meta: NetworkWorldMeta,
    private net: RoadNetwork,
    private far: Grid,
    private farMeshes: THREE.Mesh[],
    private detail: Detail,
    private mid: Grid | null = null,
  ) {
    this.frame = new Frame(meta.origin.lat, meta.origin.lon);
    this.index = new NetworkIndex(net);
    this.inTunnel = new Uint8Array(net.points);
    this.uncut = new Uint8Array(net.points);
    this.tubeZone = new Uint8Array(net.points);
    for (const e of net.edges) {
      if (!e.tunnel) continue;
      this.inTunnel.fill(1, e.start, e.start + e.count);
      this.tubeZone.fill(1, e.start, e.start + e.count);
      if (e.count > 4) this.uncut.fill(1, e.start + 2, e.start + e.count - 2);
      // The last 20 m of the roads leading to the portals count too: their cut banks would cross the tube's mouth.
      for (const f of net.edges) {
        if (f.tunnel) continue;
        if (f.a === e.a || f.a === e.b) this.tubeZone.fill(1, f.start, Math.min(f.start + 3, f.start + f.count));
        if (f.b === e.a || f.b === e.b) this.tubeZone.fill(1, Math.max(f.start, f.start + f.count - 3), f.start + f.count);
      }
    }
    for (const m of farMeshes) this.farBase.set(m, Float32Array.from((m.geometry.attributes.position as THREE.BufferAttribute).array));
  }

  /** Ground height anywhere: the loaded tile if there is one, else the far layer, both with the road corridor cut in. */
  heightAt = (x: number, z: number): number => {
    const raw = this.rawAt(x, z);
    return this.corridor(x, z, raw);
  };

  /** Is this ground position inside a tunnel (over its road, within the tube)? The camera must not climb out through the mountain there. */
  tunnelAt = (x: number, z: number): boolean => {
    const n = this.index.nearest(x, z, 12);
    return n.i >= 0 && n.d < 12 && this.inTunnel[n.i] === 1;
  };

  private rawAt(x: number, z: number): number {
    for (const t of this.tiles.values()) {
      if (t.grid && x >= t.x0 && x < t.x1 && z >= t.z0 && z < t.z1) {
        const h = gridSample(t.grid, x, z);
        if (h !== null) return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
      }
    }
    const h = (this.mid && gridSample(this.mid, x, z)) ?? gridSample(this.far, x, z) ?? SEA_LEVEL - 10;
    return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
  }

  private corridor(x: number, z: number, h: number): number {
    const n = this.index.nearest(x, z, CORRIDOR_REACH);
    if (n.i < 0 || this.uncut[n.i]) return h;
    return corridorHeight(h, n.d, n.y);
  }

  /** Call every frame with the rider's position and the camera position. */
  private riderX = 0;
  private riderZ = 0;

  update(x: number, z: number, camera: THREE.Vector3) {
    this.riderX = x;
    this.riderZ = z;
    const [lat, lon] = this.frame.toLatLon(x, z);
    const { dlat, dlon } = this.meta.tiles;
    const i0 = Math.floor(lat / dlat);
    const j0 = Math.floor(lon / dlon);
    const wanted: Tile[] = [];
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      for (let j = j0 - 2; j <= j0 + 2; j++) {
        const [cx, cz] = this.frame.toXZ((i + 0.5) * dlat, (j + 0.5) * dlon);
        if (Math.hypot(cx - x, cz - z) > LOAD_RADIUS_M) continue;
        const key = `${i}_${j}`;
        let t = this.tiles.get(key);
        if (!t) {
          const [xa, za] = this.frame.toXZ((i + 1) * dlat, j * dlon);
          const [xb, zb] = this.frame.toXZ(i * dlat, (j + 1) * dlon);
          t = { key, i, j, x0: xa, z0: za, x1: xb, z1: zb, grid: null, group: new THREE.Group(), posts: [], state: "loading", ground: [], coarse: false, refining: false, veg: null, photoColor: null };
          this.tiles.set(key, t);
          wanted.push(t);
          console.info(`tile ${key}: queued at ${(performance.now() / 1000).toFixed(1)} s, ${Math.hypot(cx - x, cz - z).toFixed(0)} m away`);
        }
      }
    }
    // Nearest first.
    wanted.sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - x, (a.z0 + a.z1) / 2 - z) - Math.hypot((b.x0 + b.x1) / 2 - x, (b.z0 + b.z1) / 2 - z));
    this.queue.push(...wanted);
    this.pump();
    let refining = false;
    for (const t of this.tiles.values()) {
      const d = Math.hypot((t.x0 + t.x1) / 2 - x, (t.z0 + t.z1) / 2 - z);
      if (d > DROP_RADIUS_M && t.state !== "loading") this.unload(t);
      else if (t.state === "ready" && t.coarse && d < DETAIL_RADIUS_M - 100 && !refining && !this.refiningAny) {
        refining = true;
        this.refine(t);
      }
      if (t.veg) {
        const cast = d < SHADOW_RADIUS_M;
        if (t.veg.userData.cast !== cast) {
          t.veg.userData.cast = cast;
          t.veg.traverse((o) => {
            if (o instanceof THREE.Mesh) o.castShadow = cast;
          });
        }
      }
    }
    this.updateMid(x, z, lat, lon);
    const near: SignPost[] = [];
    for (const t of this.tiles.values()) {
      for (const p of t.posts) {
        const visible = Math.hypot(p.group.position.x - x, p.group.position.z - z) < SIGN_RADIUS_M;
        p.group.visible = visible;
        if (visible) near.push(p);
      }
    }
    faceCamera(near, camera);
  }

  private refiningAny = false;

  /** Rebuilds a coarse tile's ground at full detail now that the rider is near. */
  private refine(t: Tile) {
    t.refining = true;
    this.refiningAny = true;
    this.buildGround(t, 2)
      .then((meshes) => {
        if (!meshes || !this.tiles.has(t.key)) return;
        for (const m of t.ground) {
          t.group.remove(m);
          m.geometry.dispose();
        }
        t.ground = meshes;
        t.coarse = false;
        t.group.add(...meshes);
        this.plant(t);
      })
      .catch((e) => console.warn(`tile ${t.key} refine: ${e}`))
      .finally(() => {
        t.refining = false;
        this.refiningAny = false;
      });
  }

  /**
   * The ground meshes of a tile at a given sample step (2 = 10 m, 4 = 20 m):
   * heights a few rows per frame, then four blocks so the half behind the
   * camera is culled. Null when the tile was dropped meanwhile.
   */
  private async buildGround(t: Tile, step: number): Promise<THREE.Mesh[] | null> {
    const grid = t.grid!;
    const tex = t.tex!;
    // The coarse grid near a road: never above the cut bank (or a cutting would
    // wall the road in), free to lie below it (a fill clamp would terrace the
    // downhill side at 10 m), and ducked under the corridor strip.
    const tucked = (x: number, z: number) => {
      const h = this.rawAt(x, z);
      const n = this.index.nearest(x, z, CORRIDOR_REACH);
      if (n.i < 0 || n.d > CORRIDOR_REACH || this.uncut[n.i]) return h;
      const bed = n.y - 0.35;
      const top = n.d <= SHOULDER ? bed : bed + (n.d - SHOULDER) * CUT_SLOPE;
      const depth = 1.2 + 2.5 * Math.min(1.5, gridSlope(grid, x, z));
      // The same fade as the corridor field, so the grid never steps where the strip ends.
      const f = smoothstep(CORRIDOR_REACH - CORRIDOR_BLEND_M, CORRIDOR_REACH, n.d);
      return lerp(Math.min(h, top), h, f) - depth * (1 - f);
    };
    // The mesh grid: every `step / 2` sample of the 10 m data.
    const k = step / 2;
    const cols = Math.floor((grid.cols - 1) / k) + 1;
    const rows = Math.floor((grid.rows - 1) / k) + 1;
    const sx = grid.spacing * k;
    const sz = grid.spacingZ! * k;
    const g: Grid = { cols, rows, x0: grid.x0, z0: grid.z0, spacing: sx, spacingZ: sz, data: grid.data };
    // One ring of vertices beyond the data, hanging 6 m below the edge: a skirt
    // that closes the seam to the neighbouring tile (their grids abut, they do
    // not share a row) whether or not that tile is loaded yet.
    const skirted = (x: number, z: number) => {
      const cx = Math.min(Math.max(x, g.x0), g.x0 + (cols - 1) * sx);
      const cz = Math.min(Math.max(z, g.z0), g.z0 + (rows - 1) * sz);
      return cx === x && cz === z ? tucked(x, z) : tucked(cx, cz) - 6;
    };
    const ringCols = cols + 2;
    const heights = new Float32Array((rows + 2) * ringCols);
    let sliceStart = performance.now();
    for (let iz = -1; iz <= rows; iz++) {
      const z = g.z0 + iz * sz;
      for (let ix = -1; ix <= cols; ix++) heights[(iz + 1) * ringCols + ix + 1] = skirted(g.x0 + ix * sx, z);
      // A few milliseconds per frame, then the frame gets drawn.
      if (performance.now() - sliceStart > BUILD_BUDGET_MS) {
        await nextFrame();
        if (!this.tiles.has(t.key)) return null;
        sliceStart = performance.now();
      }
    }
    const lookup = (x: number, z: number) => heights[(Math.round((z - g.z0) / sz) + 1) * ringCols + Math.round((x - g.x0) / sx) + 1];
    // No ground over a tunnel tube where the surface would cross it (the mountain coming
    // down to the portal); deep under the mountain the ground stays, so no slot shows from above.
    const overTunnel = (x: number, z: number) => {
      const n = this.index.nearest(x, z, TUNNEL_HALF + 1);
      if (n.i < 0 || n.d >= TUNNEL_HALF + 1 || this.tubeZone[n.i] !== 1) return false;
      return lookup(x, z) < this.net.xyz[n.i * 3 + 1] + TUBE_CLEAR_M;
    };
    const midR = rows >> 1;
    const midC = cols >> 1;
    const meshes: THREE.Mesh[] = [];
    for (const rr of [[-1, midR] as [number, number], [midR, rows] as [number, number]]) {
      for (const cc of [[-1, midC] as [number, number], [midC, cols] as [number, number]]) {
        meshes.push(gridBlockMesh(g, lookup, rr, cc, tex, this.detail, 1, overTunnel, [-1, rows], [-1, cols]));
      }
    }
    return meshes;
  }

  /** Trees, bushes and rocks for a near tile. */
  private plant(t: Tile) {
    if (t.veg || !t.grid) return;
    const grid = t.grid;
    const land: Land = { height: this.heightAt, water: (x, z) => this.rawAt(x, z) < SEA_LEVEL + 1.5, slope: (x, z) => gridSlope(grid, x, z) };
    const region = { x0: t.x0, z0: t.z0, w: t.x1 - t.x0, h: t.z1 - t.z0 };
    const area = region.w * region.h;
    t.veg = vegetation(this.index, this.heightAt, land, region, new RouteSampler({ name: "", points: [], closed: false, world: null }), true, t.photoColor, area / 53e6);
    t.veg.userData.cast = true;
    t.group.add(t.veg);
  }

  /** How many tiles are still being built; the HUD shows it. */
  get pending(): number {
    return this.queue.length + this.loading;
  }

  /** Resolves once the tile under `(x, z)` is built (or failed), or after `timeoutMs`. */
  whenReady(x: number, z: number, timeoutMs = 90000): Promise<void> {
    const started = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const t = [...this.tiles.values()].find((t) => x >= t.x0 && x < t.x1 && z >= t.z0 && z < t.z1);
        if ((t && t.state !== "loading") || performance.now() - started > timeoutMs) resolve();
        else setTimeout(check, 200);
      };
      check();
    });
  }

  private pump() {
    while (this.loading < 2 && this.queue.length) {
      const t = this.queue.shift()!;
      if (!this.tiles.has(t.key)) continue;
      this.loading++;
      this.load(t)
        .catch((e) => {
          console.warn(`tile ${t.key}: ${e}`);
          t.state = "failed";
        })
        .finally(() => {
          this.loading--;
          this.pump();
        });
    }
  }

  private unload(t: Tile) {
    this.tiles.delete(t.key);
    this.scene.remove(t.group);
    t.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (!o.geometry.userData.shared) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.userData.shared) continue;
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.resink(t);
  }

  /**
   * Lowers the coarser layers under the finer ones so they cannot poke
   * through: the far layer under mid blocks and tiles, mid blocks under
   * tiles. Recomputed for every mesh overlapping `box` from the meshes' base
   * heights, so a layer dropped elsewhere restores only what nothing covers.
   */
  private resink(box: { x0: number; z0: number; x1: number; z1: number }) {
    const tiles = [...this.tiles.values()].filter((t) => t.state === "ready");
    const mids = [...this.mids.values()].filter((m) => m.mesh);
    // A vertex one sample beyond the finer layer's edge goes down too: its cell would otherwise rise through the edge.
    const inside = (b: { x0: number; z0: number; x1: number; z1: number }, x: number, z: number, m: number) => x >= b.x0 - m && x <= b.x1 + m && z >= b.z0 - m && z <= b.z1 + m;
    const depth = (x: number, z: number, margin: number, underMid: boolean) => {
      if (tiles.some((t) => inside(t, x, z, margin))) return SINK_UNDER_TILE;
      if (underMid && mids.some((m) => inside(m.box, x, z, margin))) return SINK_UNDER_MID;
      return 0;
    };
    const lower = (mesh: THREE.Mesh, base: Float32Array, margin: number, underMid: boolean) => {
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, base[i * 3 + 1] - depth(base[i * 3], base[i * 3 + 2], margin, underMid));
      pos.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
    };
    const grow = 2 * this.far.spacing;
    const overlaps = (mesh: THREE.Mesh) => {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!;
      return b.max.x >= box.x0 - grow && b.min.x <= box.x1 + grow && b.max.z >= box.z0 - grow && b.min.z <= box.z1 + grow;
    };
    for (const m of this.farMeshes) if (overlaps(m)) lower(m, this.farBase.get(m)!, this.far.spacing, true);
    const midSpacing = this.mid?.spacing ?? 0;
    for (const b of mids) if (overlaps(b.mesh!)) lower(b.mesh!, b.base!, midSpacing, false);
  }

  // --- mid-distance blocks --------------------------------------------------------

  private updateMid(x: number, z: number, lat: number, lon: number) {
    if (!this.mid) return;
    const [mx, my] = mercator(lat, lon, MID_ZOOM);
    const tx0 = Math.floor(mx);
    const ty0 = Math.floor(my);
    const n = 2 ** MID_ZOOM;
    for (let ty = ty0 - 3; ty <= ty0 + 3; ty++) {
      for (let tx = tx0 - 3; tx <= tx0 + 3; tx++) {
        const key = `${tx}_${ty}`;
        if (this.mids.has(key)) continue;
        // The tile's bounds: lon from x, lat from the inverse Mercator of y.
        const lon0 = (tx / n) * 360 - 180;
        const lon1 = ((tx + 1) / n) * 360 - 180;
        const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
        const lat1 = latOf(ty);
        const lat0 = latOf(ty + 1);
        const [x0, z0] = this.frame.toXZ(lat1, lon0);
        const [x1, z1] = this.frame.toXZ(lat0, lon1);
        if (Math.hypot((x0 + x1) / 2 - x, (z0 + z1) / 2 - z) > MID_RADIUS_M) continue;
        // Only where the mid grid has data.
        const g = this.mid;
        if (x1 < g.x0 || z1 < g.z0 || x0 > g.x0 + (g.cols - 1) * g.spacing || z0 > g.z0 + (g.rows - 1) * (g.spacingZ ?? g.spacing)) continue;
        this.mids.set(key, { key, box: { x0, z0, x1, z1 }, lat0, lat1, lon0, lon1, mesh: null, base: null, state: "loading" });
      }
    }
    for (const b of this.mids.values()) {
      const d = Math.hypot((b.box.x0 + b.box.x1) / 2 - x, (b.box.z0 + b.box.z1) / 2 - z);
      if (d > MID_DROP_M && b.state !== "loading") this.unloadMid(b);
    }
    this.pumpMid(x, z);
  }

  private pumpMid(x: number, z: number) {
    if (this.midLoading >= 1) return;
    // Nearest first.
    const waiting = [...this.mids.values()].filter((b) => b.state === "loading" && !b.mesh && !b.base);
    if (!waiting.length) return;
    waiting.sort((a, b) => Math.hypot((a.box.x0 + a.box.x1) / 2 - x, (a.box.z0 + a.box.z1) / 2 - z) - Math.hypot((b.box.x0 + b.box.x1) / 2 - x, (b.box.z0 + b.box.z1) / 2 - z));
    const b = waiting[0];
    b.base = new Float32Array(0); // claimed
    this.midLoading++;
    this.loadMid(b)
      .catch((e) => {
        console.warn(`mid block ${b.key}: ${e}`);
        b.state = "failed";
      })
      .finally(() => {
        this.midLoading--;
        this.pumpMid(this.riderX, this.riderZ);
      });
  }

  private async loadMid(b: MidBlock) {
    const g = this.mid!;
    const photo = await this.fetchOrtho(b.lat0, b.lat1, b.lon0, b.lon1, this.meta.tiles.ortho, MID_ORTHO_ZOOM, 512);
    if (!this.mids.has(b.key)) return;
    const sz = g.spacingZ ?? g.spacing;
    const fr0 = (b.box.z0 - g.z0) / sz;
    const fr1 = (b.box.z1 - g.z0) / sz;
    const fc0 = (b.box.x0 - g.x0) / g.spacing;
    const fc1 = (b.box.x1 - g.x0) / g.spacing;
    const r0 = Math.max(0, Math.floor(fr0));
    const r1 = Math.min(g.rows - 1, Math.ceil(fr1));
    const c0 = Math.max(0, Math.floor(fc0));
    const c1 = Math.min(g.cols - 1, Math.ceil(fc1));
    if (r1 - r0 < 2 || c1 - c0 < 2) {
      b.state = "failed";
      return;
    }
    const height = (x: number, z: number) => {
      const h = gridSample(g, x, z) ?? SEA_LEVEL - 10;
      return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
    };
    const tex = imageTexture(photo.bitmap);
    const mesh = gridBlockMesh(g, height, [r0, r1], [c0, c1], tex, this.detail, 0.7, undefined, [fr0, fr1], [fc0, fc1]);
    mesh.geometry.computeBoundingBox();
    b.mesh = mesh;
    b.base = Float32Array.from((mesh.geometry.attributes.position as THREE.BufferAttribute).array);
    b.state = "ready";
    this.scene.add(mesh);
    this.resink(b.box);
  }

  private unloadMid(b: MidBlock) {
    this.mids.delete(b.key);
    if (b.mesh) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      const m = b.mesh.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
      this.resink(b.box);
    }
  }

  private async load(t: Tile) {
    const { dlat, dlon, dem, ortho, orthoZoom } = this.meta.tiles;
    const lat0 = t.i * dlat;
    const lat1 = (t.i + 1) * dlat;
    const lon0 = t.j * dlon;
    const lon1 = (t.j + 1) * dlon;
    const url = dem.replace("{lat0}", lat0.toFixed(5)).replace("{lat1}", lat1.toFixed(5)).replace("{lon0}", lon0.toFixed(5)).replace("{lon1}", lon1.toFixed(5));
    const t0 = performance.now();
    const [tiff, photo] = await Promise.all([api.fetchCached(url), this.fetchOrtho(lat0, lat1, lon0, lon1, ortho, orthoZoom)]);
    const t1 = performance.now();
    const geo = parseGeoTiff(tiff);
    // Every other sample: 10 m is plenty for the mesh, the corridor adds the fine shape near the road.
    const step = 2;
    const cols = Math.floor((geo.width - 1) / step) + 1;
    const rows = Math.floor((geo.height - 1) / step) + 1;
    const data = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = geo.data[r * step * geo.width + c * step];
    const [x0, z0] = this.frame.toXZ(geo.lat0, geo.lon0);
    const grid: Grid = { cols, rows, x0, z0, spacing: geo.dlon * step * this.frame.kx, spacingZ: geo.dlat * step * EARTH_LAT_M, data };
    t.grid = grid;
    if (!this.tiles.has(t.key)) return; // dropped while loading

    const group = t.group;
    t.tex = imageTexture(photo.bitmap);
    t.photoColor = photo.colorAt;
    // Near tiles get the full 10 m ground now; far ones a 20 m one, refined when the rider comes close.
    t.coarse = Math.hypot((t.x0 + t.x1) / 2 - this.riderX, (t.z0 + t.z1) / 2 - this.riderZ) > DETAIL_RADIUS_M;
    const ground = await this.buildGround(t, t.coarse ? 4 : 2);
    if (!ground) return;
    t.ground = ground;
    group.add(...ground);
    await nextFrame();
    if (!this.tiles.has(t.key)) return;

    // Roads in this tile: the stretches of each edge inside it, plus one point beyond for continuity.
    const inside = (x: number, z: number) => x >= t.x0 && x < t.x1 && z >= t.z0 && z < t.z1;
    const edges = this.index.edgesIn(t.x0, t.z0, t.x1, t.z1, 60);
    // Road pieces are collected and merged by kind: one draw call per kind per tile instead of one per piece.
    const pieces: THREE.Mesh[] = [];
    let budget = performance.now();
    for (const ei of edges) {
      const pts = this.index.polyline(ei);
      const e = this.index.edge(ei);
      let run: typeof pts = [];
      let runStart = 0;
      const build = (part: typeof pts, partStart: number) => {
        const cls = ROAD_CLASS[Math.min(ROAD_CLASS.length - 1, e.kind)];
        // Numbered tertiary roads (the Ma-10 itself, Sa Calobra) are marked like main roads.
        const lines = e.kind === 2 && e.ref ? "centre" : cls.lines;
        pieces.push(...roadMeshes(part, false, cls.width, true, this.asphalt, lines));
        if (e.tunnel) {
          group.add(tunnelMesh(part, this.detail.rock));
        } else {
          pieces.push(corridorMesh(part, this.index, this.heightAt, null, this.detail.grain, photo.colorAt, this.detail, ei, e.start + partStart));
          pieces.push(parapets(part, this.heightAt, cls.width, this.detail.rock));
        }
      };
      const flush = async () => {
        // Long runs go in pieces of 60 points (300 m), with a frame between, so no single piece stalls the picture.
        for (let k = 0; k + 1 < run.length; k += 59) {
          const part = run.slice(k, Math.min(run.length, k + 60));
          if (part.length >= 2 && !(e.tunnel && k > 0)) build(part, runStart + k);
          if (k + 60 < run.length) await nextFrame();
        }
        run = [];
      };
      for (let k = 0; k < pts.length; k++) {
        if (inside(pts[k].x, pts[k].z)) {
          if (!run.length) runStart = k;
          run.push(pts[k]);
        } else if (run.length) {
          run.push(pts[k]);
          await flush();
          if (!this.tiles.has(t.key)) return;
        }
      }
      await flush();
      if (!this.tiles.has(t.key)) return;
      if (performance.now() - budget > BUILD_BUDGET_MS) {
        await nextFrame();
        if (!this.tiles.has(t.key)) return;
        budget = performance.now();
      }
    }
    group.add(...mergeByKind(pieces));
    await nextFrame();
    if (!this.tiles.has(t.key)) return;

    // Confirmation signs along the roads: on the right of the direction they serve.
    for (const ei of edges) {
      const e = this.index.edge(ei);
      for (const m of e.markers ?? []) {
        // The two directions' signs stand 150 m apart, each on the right of its own traffic.
        const i = e.start + m.at + (m.toward_b ? 0 : 30);
        if (i < e.start + 2 || i >= e.start + e.count - 2) continue;
        const xyz = this.net.xyz;
        if (!inside(xyz[i * 3], xyz[i * 3 + 2])) continue;
        const [i0, i1] = m.toward_b ? [i - 2, i + 2] : [i + 2, i - 2];
        const dx = xyz[i1 * 3] - xyz[i0 * 3];
        const dz = xyz[i1 * 3 + 2] - xyz[i0 * 3 + 2];
        const l = Math.hypot(dx, dz) || 1;
        // Right of travel in an x-east, z-south frame is (−dz, dx).
        const px = xyz[i * 3] + (-dz / l) * (cls_width(e.kind) / 2 + 1.6);
        const pz = xyz[i * 3 + 2] + (dx / l) * (cls_width(e.kind) / 2 + 1.6);
        const post = confirmationPost(m.to, px, pz, this.heightAt(px, pz), -dx / l, -dz / l);
        group.add(post.group);
        t.posts.push(post);
      }
    }
    await nextFrame();
    if (!this.tiles.has(t.key)) return;

    // Signs: one post per approach at every junction inside the tile, but not
    // at junctions of minor roads only, and not within 30 m of another post.
    const placed: [number, number][] = [];
    for (let ni = 0; ni < this.net.nodes.length; ni++) {
      const node = this.net.nodes[ni];
      if (!node.signs || !inside(node.x, node.z)) continue;
      // Only where numbered roads meet: town streets would fill a tile with posts.
      if (node.signs.filter((s) => this.net.edges[s.edge].ref).length < 2) continue;
      if (!node.signs.some((s) => this.net.edges[s.edge].kind <= 2)) continue;
      if (placed.some(([px, pz]) => Math.hypot(px - node.x, pz - node.z) < 30)) continue;
      placed.push([node.x, node.z]);
      const edgesHere = node.signs.map((s) => s.edge);
      const bearingOf = (edge: number) => this.bearingOut(edge, ni);
      for (const approach of edgesHere) {
        const b = bearingOf(approach); // leaving along the approach edge = opposite of arriving
        const facing = b; // the post faces riders arriving along this edge
        const back = (b * Math.PI) / 180;
        // 14 m back along the approach, 4 m to the right of it.
        const px = node.x + Math.cos(back) * 14 + Math.cos(back + Math.PI / 2) * -4.5;
        const pz = node.z + Math.sin(back) * 14 + Math.sin(back + Math.PI / 2) * -4.5;
        const post = signPost({ ...node, signs: node.signs.filter((s) => s.edge !== approach) }, px, pz, this.heightAt(px, pz), bearingOf, facing + 180);
        if (post) {
          group.add(post.group);
          t.posts.push(post);
        }
      }
      // Lettering the boards is canvas work: a frame per junction.
      await nextFrame();
      if (!this.tiles.has(t.key)) return;
    }

    if (!t.coarse) this.plant(t);

    this.scene.add(group);
    t.state = "ready";
    this.resink(t);
    console.info(`tile ${t.key}: ready at ${(performance.now() / 1000).toFixed(1)} s, fetched in ${(t1 - t0).toFixed(0)} ms, built in ${(performance.now() - t1).toFixed(0)} ms`);
  }

  /** Bearing in degrees (x east, z south) of an edge leaving `node`. */
  private bearingOut(edge: number, node: number): number {
    const e = this.net.edges[edge];
    const xyz = this.net.xyz;
    const k = Math.min(3, e.count - 1);
    const [i0, i1] = e.a === node ? [e.start, e.start + k] : [e.start + e.count - 1, e.start + e.count - 1 - k];
    return (Math.atan2(xyz[i1 * 3 + 2] - xyz[i0 * 3 + 2], xyz[i1 * 3] - xyz[i0 * 3]) * 180) / Math.PI;
  }

  /** The aerial photo of a tile: WMTS tiles stitched, cropped to the tile's box, with a sampler for colours. */
  private async fetchOrtho(lat0: number, lat1: number, lon0: number, lon1: number, template: string, zoom: number, size = 1024) {
    const [mx0, my0] = mercator(lat1, lon0, zoom);
    const [mx1, my1] = mercator(lat0, lon1, zoom);
    const tx0 = Math.floor(mx0);
    const ty0 = Math.floor(my0);
    const tx1 = Math.floor(mx1);
    const ty1 = Math.floor(my1);
    const jobs: Promise<void>[] = [];
    const mosaic = document.createElement("canvas");
    mosaic.width = (tx1 - tx0 + 1) * WMTS_TILE;
    mosaic.height = (ty1 - ty0 + 1) * WMTS_TILE;
    const mctx = mosaic.getContext("2d")!;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = template.replace("{z}", String(zoom)).replace("{x}", String(tx)).replace("{y}", String(ty));
        jobs.push(
          api
            .fetchCached(url)
            .then((buf) => createImageBitmap(new Blob([buf], { type: "image/jpeg" })))
            .then((bmp) => mctx.drawImage(bmp, (tx - tx0) * WMTS_TILE, (ty - ty0) * WMTS_TILE))
            .catch((e) => console.warn(`ortho ${tx},${ty}: ${e}`)),
        );
      }
    }
    await Promise.all(jobs);
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const octx = out.getContext("2d")!;
    octx.drawImage(mosaic, (mx0 - tx0) * WMTS_TILE, (my0 - ty0) * WMTS_TILE, (mx1 - mx0) * WMTS_TILE, (my1 - my0) * WMTS_TILE, 0, 0, size, size);
    const bitmap = await createImageBitmap(out);
    // A smaller copy for reading colours.
    const sample = document.createElement("canvas");
    sample.width = sample.height = 256;
    const sctx = sample.getContext("2d", { willReadFrequently: true })!;
    sctx.drawImage(out, 0, 0, 256, 256);
    const pixels = sctx.getImageData(0, 0, 256, 256).data;
    const [x0, z0] = this.frame.toXZ(lat1, lon0);
    const [x1, z1] = this.frame.toXZ(lat0, lon1);
    // Just outside the tile (a corridor strip reaching past its edge) the nearest edge pixel is used, not a made-up rock colour.
    const colorAt = (x: number, z: number): [number, number, number] | null => {
      const u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
      const v = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
      const i = (Math.min(255, Math.floor(v * 256)) * 256 + Math.min(255, Math.floor(u * 256))) * 4;
      return [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255];
    };
    return { bitmap, colorAt };
  }
}

export { lerp };
