// A world the size of an island: terrain tiles fetched on demand around the
// rider (elevation from the IGN coverage service, imagery from the IGN
// WMTS, both through the app's disk cache), the road network's roads,
// corridors, parapets, trees and signs built per tile, and a static far layer.
import * as THREE from "three";
import { api } from "../api";
import { NetworkIndex, type RoadNetwork } from "./network";
import {
  CORRIDOR_REACH,
  corridorMesh,
  CUT_SLOPE,
  type Detail,
  FILL_SLOPE,
  gridBlockMesh,
  imageTexture,
  type Land,
  lerp,
  parapets,
  REAL_ROAD_WIDTH,
  roadMeshes,
  SEA_LEVEL,
  SHOULDER,
  smoothstep,
  vegetation,
} from "./scene";
import { faceCamera, signPost, type SignPost } from "./signs";
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
  group: THREE.Group;
  posts: SignPost[];
  state: "loading" | "ready" | "failed";
}

/** Load tiles whose centre is within this distance of the rider; drop them beyond the larger one. */
const LOAD_RADIUS_M = 2300;
const DROP_RADIUS_M = 3800;

export class TileManager {
  private tiles = new Map<string, Tile>();
  private queue: Tile[] = [];
  private loading = 0;
  private frame: Frame;
  private index: NetworkIndex;
  private asphalt = asphaltTexture();
  private farBase: Float32Array | null = null;

  constructor(
    private scene: THREE.Group,
    private meta: NetworkWorldMeta,
    private net: RoadNetwork,
    private far: Grid,
    private farMesh: THREE.Mesh | null,
    private detail: Detail,
  ) {
    this.frame = new Frame(meta.origin.lat, meta.origin.lon);
    this.index = new NetworkIndex(net);
    if (farMesh) this.farBase = Float32Array.from((farMesh.geometry.attributes.position as THREE.BufferAttribute).array);
  }

  /** Ground height anywhere: the loaded tile if there is one, else the far layer, both with the road corridor cut in. */
  heightAt = (x: number, z: number): number => {
    const raw = this.rawAt(x, z);
    return this.corridor(x, z, raw);
  };

  private rawAt(x: number, z: number): number {
    for (const t of this.tiles.values()) {
      if (t.grid && x >= t.x0 && x < t.x1 && z >= t.z0 && z < t.z1) {
        const h = gridSample(t.grid, x, z);
        if (h !== null) return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
      }
    }
    const h = gridSample(this.far, x, z) ?? SEA_LEVEL - 10;
    return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
  }

  private corridor(x: number, z: number, h: number): number {
    const n = this.index.nearest(x, z, CORRIDOR_REACH);
    if (n.i < 0 || n.d > CORRIDOR_REACH) return h;
    const bed = n.y - 0.35;
    if (n.d <= SHOULDER) return bed;
    const out = n.d - SHOULDER;
    return Math.min(Math.max(h, bed - out * FILL_SLOPE), bed + out * CUT_SLOPE);
  }

  /** Call every frame with the rider's position and the camera position. */
  update(x: number, z: number, camera: THREE.Vector3) {
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
          t = { key, i, j, x0: xa, z0: za, x1: xb, z1: zb, grid: null, group: new THREE.Group(), posts: [], state: "loading" };
          this.tiles.set(key, t);
          wanted.push(t);
        }
      }
    }
    // Nearest first.
    wanted.sort((a, b) => Math.hypot((a.x0 + a.x1) / 2 - x, (a.z0 + a.z1) / 2 - z) - Math.hypot((b.x0 + b.x1) / 2 - x, (b.z0 + b.z1) / 2 - z));
    this.queue.push(...wanted);
    this.pump();
    for (const t of this.tiles.values()) {
      if (Math.hypot((t.x0 + t.x1) / 2 - x, (t.z0 + t.z1) / 2 - z) > DROP_RADIUS_M && t.state !== "loading") this.unload(t);
    }
    faceCamera(
      [...this.tiles.values()].flatMap((t) => t.posts),
      camera,
    );
  }

  /** How many tiles are still being built; the HUD shows it. */
  get pending(): number {
    return this.queue.length + this.loading;
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
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
          m.dispose();
        }
      }
    });
    this.sinkFar(t, false);
  }

  /** Lowers (or restores) the far mesh under a tile so it cannot poke through the detailed terrain. */
  private sinkFar(t: Tile, sink: boolean) {
    if (!this.farMesh || !this.farBase) return;
    const g = this.far;
    const pos = this.farMesh.geometry.attributes.position as THREE.BufferAttribute;
    const sz = g.spacingZ ?? g.spacing;
    const c0 = Math.max(0, Math.floor((t.x0 - g.x0) / g.spacing) - 1);
    const c1 = Math.min(g.cols - 1, Math.ceil((t.x1 - g.x0) / g.spacing) + 1);
    const r0 = Math.max(0, Math.floor((t.z0 - g.z0) / sz) - 1);
    const r1 = Math.min(g.rows - 1, Math.ceil((t.z1 - g.z0) / sz) + 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c;
        pos.setY(i, this.farBase[i * 3 + 1] - (sink ? 80 : 0));
      }
    }
    pos.needsUpdate = true;
  }

  private async load(t: Tile) {
    const { dlat, dlon, dem, ortho, orthoZoom } = this.meta.tiles;
    const lat0 = t.i * dlat;
    const lat1 = (t.i + 1) * dlat;
    const lon0 = t.j * dlon;
    const lon1 = (t.j + 1) * dlon;
    const url = dem.replace("{lat0}", lat0.toFixed(5)).replace("{lat1}", lat1.toFixed(5)).replace("{lon0}", lon0.toFixed(5)).replace("{lon1}", lon1.toFixed(5));
    const [tiff, photo] = await Promise.all([api.fetchCached(url), this.fetchOrtho(lat0, lat1, lon0, lon1, ortho, orthoZoom)]);
    const geo = parseGeoTiff(tiff);
    // Every other sample: 10 m is plenty for the mesh, the corridor adds the fine shape near the road.
    const step = 3;
    const cols = Math.floor((geo.width - 1) / step) + 1;
    const rows = Math.floor((geo.height - 1) / step) + 1;
    const data = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[r * cols + c] = geo.data[r * step * geo.width + c * step];
    const [x0, z0] = this.frame.toXZ(geo.lat0, geo.lon0);
    const grid: Grid = { cols, rows, x0, z0, spacing: geo.dlon * step * this.frame.kx, spacingZ: geo.dlat * step * EARTH_LAT_M, data };
    t.grid = grid;
    if (!this.tiles.has(t.key)) return; // dropped while loading

    const group = t.group;
    const land: Land = { height: this.heightAt, water: (x, z) => this.rawAt(x, z) < SEA_LEVEL + 1.5, slope: (x, z) => gridSlope(grid, x, z) };
    const tucked = (x: number, z: number) => {
      const h = this.heightAt(x, z);
      const n = this.index.nearest(x, z, CORRIDOR_REACH);
      if (n.i < 0 || n.d > CORRIDOR_REACH) return h;
      const depth = 1.2 + 3.5 * Math.min(1.5, gridSlope(grid, x, z));
      return h - depth * (1 - smoothstep(CORRIDOR_REACH - 15, CORRIDOR_REACH, n.d));
    };
    const tex = imageTexture(photo.bitmap);
    group.add(gridBlockMesh(grid, tucked, [0, rows - 1], [0, cols - 1], tex, this.detail));

    // Roads in this tile: the stretches of each edge inside it, plus one point beyond for continuity.
    const inside = (x: number, z: number) => x >= t.x0 && x < t.x1 && z >= t.z0 && z < t.z1;
    const edges = this.index.edgesIn(t.x0, t.z0, t.x1, t.z1, 60);
    for (const ei of edges) {
      const pts = this.index.polyline(ei);
      const e = this.index.edge(ei);
      let run: typeof pts = [];
      let runStart = 0;
      const flush = () => {
        if (run.length >= 2) {
          group.add(...roadMeshes(run, false, REAL_ROAD_WIDTH, true, this.asphalt));
          group.add(corridorMesh(run, this.index, this.heightAt, null, this.detail.grain, photo.colorAt, this.detail, ei, e.start + runStart));
          group.add(parapets(run, this.heightAt, REAL_ROAD_WIDTH, this.detail.rock));
        }
        run = [];
      };
      for (let k = 0; k < pts.length; k++) {
        if (inside(pts[k].x, pts[k].z)) {
          if (!run.length) runStart = k;
          run.push(pts[k]);
        } else if (run.length) {
          run.push(pts[k]);
          flush();
        }
      }
      flush();
    }

    // Signs: one post per approach at every junction inside the tile.
    this.net.nodes.forEach((node, ni) => {
      if (!node.signs || !inside(node.x, node.z)) return;
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
    });

    const region = { x0: t.x0, z0: t.z0, w: t.x1 - t.x0, h: t.z1 - t.z0 };
    const area = region.w * region.h;
    group.add(vegetation(this.index, this.heightAt, land, region, new RouteSampler({ name: "", points: [], closed: false, world: null }), true, photo.colorAt, area / 53e6));

    this.scene.add(group);
    this.sinkFar(t, true);
    t.state = "ready";
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
  private async fetchOrtho(lat0: number, lat1: number, lon0: number, lon1: number, template: string, zoom: number) {
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
    const size = 1024;
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
    const colorAt = (x: number, z: number): [number, number, number] | null => {
      const u = (x - x0) / (x1 - x0);
      const v = (z - z0) / (z1 - z0);
      if (u < 0 || v < 0 || u > 1 || v > 1) return null;
      const i = (Math.min(255, Math.floor(v * 256)) * 256 + Math.min(255, Math.floor(u * 256))) * 4;
      return [pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255];
    };
    return { bitmap, colorAt };
  }
}

export { lerp };
