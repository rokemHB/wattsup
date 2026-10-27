// Static world geometry built once from the route: terrain, road, lake, trees, sky.
import * as THREE from "three";
import type { Route } from "../types";
import { fbm, mulberry32 } from "./noise";
import { RouteSampler } from "./route";

export const ROAD_WIDTH = 7;
const TERRAIN_SIZE = 3400;
const TERRAIN_SEGMENTS = 220;
const LAKE_RADIUS = 300;

export interface WorldStatics {
  group: THREE.Group;
  /** Terrain height at a ground position. */
  heightAt: (x: number, z: number) => number;
  lake: { x: number; z: number; y: number };
}

/** Nearest route sample within a few hundred metres, through a coarse grid. */
class RouteIndex {
  private cells = new Map<string, number[]>();
  private cell = 60;
  constructor(private pts: Route["points"]) {
    pts.forEach((p, i) => {
      const key = this.key(p.x, p.z);
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
  }
  private key(x: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
  nearest(x: number, z: number, radius: number): { d: number; y: number } {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = Infinity;
    let y = 0;
    for (let i = -r; i <= r; i++) {
      for (let k = -r; k <= r; k++) {
        const list = this.cells.get(`${cx + i},${cz + k}`);
        if (!list) continue;
        for (const idx of list) {
          const p = this.pts[idx];
          const d = Math.hypot(p.x - x, p.z - z);
          if (d < best) {
            best = d;
            y = p.y;
          }
        }
      }
    }
    return { d: best, y };
  }
}

const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(Math.max((t - a) / (b - a), 0), 1);
  return x * x * (3 - 2 * x);
};

export function buildWorld(route: Route): WorldStatics {
  const sampler = new RouteSampler(route);
  const pts = route.points;
  const index = new RouteIndex(pts);
  const group = new THREE.Group();

  // The lake sits in the middle of the loop, below the lowest bit of road.
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const lake = { x: cx, z: cz, y: sampler.minY - 6 };

  const heightAt = (x: number, z: number): number => {
    const hills = (fbm(x, z, 520, 3) - 0.35) * 110 + (fbm(x, z, 90, 11) - 0.5) * 8;
    const near = index.nearest(x, z, 240);
    const road = near.d < 240 ? near.y - 0.35 : hills;
    let h = road + (hills - road) * smoothstep(9, 150, near.d);
    const toLake = Math.hypot(x - lake.x, z - lake.z);
    const lakeBed = lake.y - 4;
    h = lakeBed + (h - lakeBed) * smoothstep(LAKE_RADIUS - 20, LAKE_RADIUS + 90, toLake);
    return h;
  };

  // Terrain.
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const grassLow = new THREE.Color("#6fae4f");
  const grassHigh = new THREE.Color("#9ccb6a");
  const rock = new THREE.Color("#8d8577");
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    const h = heightAt(x, z);
    pos.setXYZ(i, x, h, z);
    const t = smoothstep(sampler.minY, sampler.maxY + 60, h);
    tmp.copy(grassLow).lerp(grassHigh, t);
    if (h > sampler.maxY + 40) tmp.lerp(rock, smoothstep(sampler.maxY + 40, sampler.maxY + 110, h));
    colors.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  terrain.receiveShadow = true;
  group.add(terrain);

  // Lake.
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(LAKE_RADIUS + 30, 64),
    new THREE.MeshPhongMaterial({ color: "#3f8fd2", shininess: 90, specular: "#dff3ff", transparent: true, opacity: 0.92 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(lake.x, lake.y, lake.z);
  group.add(water);

  // Road: a ribbon with a lighter shoulder, edge lines and a dashed centre line.
  group.add(ribbon(pts, route.closed, ROAD_WIDTH + 1.6, 0.02, "#b7a98a"));
  group.add(ribbon(pts, route.closed, ROAD_WIDTH, 0.05, "#4a4d55"));
  group.add(ribbon(pts, route.closed, ROAD_WIDTH - 0.5, 0.07, "#4a4d55", { lineWidth: 0.18, color: "#e8e6dc", offset: (ROAD_WIDTH - 0.5) / 2 }));
  group.add(ribbon(pts, route.closed, 0.18, 0.08, "#f2d75c", { dashed: true }));

  // Trees: instanced cones and trunks, kept off the road and out of the water.
  const rand = mulberry32(42);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 2.2, 6);
  const crownGeo = new THREE.ConeGeometry(2.4, 7, 7);
  crownGeo.translate(0, 5.3, 0);
  trunkGeo.translate(0, 1.1, 0);
  const count = 2600;
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: "#6b4a2b" }), count);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: "#ffffff" }), count);
  const m = new THREE.Matrix4();
  const crownColor = new THREE.Color();
  const palette = ["#2f7d3a", "#3c8f3f", "#4f9a48", "#2b6b45", "#6ea35a"];
  let placed = 0;
  let tries = 0;
  while (placed < count && tries < count * 20) {
    tries++;
    const x = cx + (rand() - 0.5) * (TERRAIN_SIZE * 0.78);
    const z = cz + (rand() - 0.5) * (TERRAIN_SIZE * 0.78);
    if (Math.hypot(x - lake.x, z - lake.z) < LAKE_RADIUS + 60) continue;
    const near = index.nearest(x, z, 240);
    if (near.d < ROAD_WIDTH / 2 + 4) continue;
    // Denser near the road, sparse far away, and none on the rocky tops.
    const density = 0.25 + 0.75 * (1 - smoothstep(20, 400, near.d));
    if (rand() > density || fbm(x, z, 300, 5) < 0.42) continue;
    const y = heightAt(x, z);
    if (y > sampler.maxY + 45) continue;
    const s = 0.7 + rand() * 0.8;
    m.makeRotationY(rand() * Math.PI * 2);
    m.scale(new THREE.Vector3(s, s * (0.8 + rand() * 0.5), s));
    m.setPosition(x, y, z);
    trunks.setMatrixAt(placed, m);
    crowns.setMatrixAt(placed, m);
    crowns.setColorAt(placed, crownColor.set(palette[Math.floor(rand() * palette.length)]));
    placed++;
  }
  trunks.count = placed;
  crowns.count = placed;
  crowns.castShadow = true;
  group.add(trunks, crowns);

  return { group, heightAt, lake };
}

interface RibbonMarks {
  dashed?: boolean;
  lineWidth?: number;
  color?: string;
  offset?: number;
}

/** A flat strip of `width` metres following the route points, `lift` above them. */
function ribbon(pts: Route["points"], closed: boolean, width: number, lift: number, color: string, marks: RibbonMarks = {}): THREE.Mesh {
  const n = pts.length;
  const verts: number[] = [];
  const idx: number[] = [];
  const half = width / 2;
  const edge = marks.lineWidth !== undefined;
  for (let i = 0; i < n; i++) {
    const a = pts[i === 0 ? (closed ? n - 2 : 0) : i - 1];
    const b = pts[i === n - 1 ? (closed ? 1 : n - 1) : i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    const p = pts[i];
    if (edge) {
      // Two thin strips at ±offset.
      for (const side of [-1, 1]) {
        const o = side * (marks.offset ?? half);
        const w = marks.lineWidth! / 2;
        verts.push(p.x + nx * (o - w), p.y + lift, p.z + nz * (o - w), p.x + nx * (o + w), p.y + lift, p.z + nz * (o + w));
      }
    } else {
      verts.push(p.x + nx * half, p.y + lift, p.z + nz * half, p.x - nx * half, p.y + lift, p.z - nz * half);
    }
  }
  const stride = edge ? 4 : 2;
  for (let i = 0; i < n - 1; i++) {
    if (marks.dashed && i % 4 >= 2) continue;
    for (let s = 0; s < stride; s += 2) {
      const a = i * stride + s;
      const b = (i + 1) * stride + s;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color: marks.color ?? color, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}
