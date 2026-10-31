// Houses along a road, placed on both sides of the stretches the world marks as urban.
// Each house stands on a stone plinth rooted below its lowest corner and reaching the
// street, so no window ever sits in the ground; its ground floor faces the street with a
// door, a shopfront or a garage, the floors above have shuttered windows or balconies, and
// it ends in a cornice and a flat roof with a parapet or a tiled gable. A kerbed pavement
// runs between road and houses. The walls are laid out bay by bay (3.6 m by a storey) with
// texture coordinates into one painted atlas per plaster colour, so a town is a handful of
// draw calls: one per colour, the plinths, the roofs and the pavements.
import * as THREE from "three";
import type { Route } from "../types";
import { mulberry32 } from "./noise";
import { RouteSampler } from "./route";

export interface UrbanRange {
  /** Metres along the route. */
  from: number;
  to: number;
  /** Fewest and most storeys. */
  floors: [number, number];
  /** A white village (Colmenar, Riogordo): whitewash, tiled roofs, mostly front doors. A city otherwise. */
  style?: "city" | "village";
}

const FLOOR_M = 3;
const GROUND_FLOOR_M = 3.6;
/** One bay: a window, a door or a shopfront wide. */
const BAY_M = 3.6;
const PAVEMENT_M = 2.4;
const VILLAGE_PAVEMENT_M = 1.4;
const KERB_M = 0.15;
const PLASTERS = ["#ece6d8", "#dcc49a", "#d9a37c", "#e8d9c4", "#f2efe8", "#f7f5ef"];
/** The whitewashed ones, for villages. */
const WHITES = [4, 5];
const SHUTTERS = ["#4f6b4a", "#6b4a32", "#3f5a6e", "#7a6a4a"];

/** The atlas cells, 3 across and 2 down. */
const CELL = { window: 0, balcony: 1, door: 2, shop: 3, garage: 4, plain: 5 } as const;
type Cell = (typeof CELL)[keyof typeof CELL];

interface Materials {
  walls: THREE.MeshStandardMaterial[];
  plinth: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  tiles: THREE.MeshStandardMaterial;
  pavement: THREE.MeshStandardMaterial;
}
let materials: Materials | null = null;

function canvasTexture(canvas: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Paints one plaster colour's atlas: six cells of 128 x 128 px. */
function paintAtlas(plaster: string, shutter: string, rand: () => number): HTMLCanvasElement {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = S * 3;
  canvas.height = S * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = plaster;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${(rand() * 0.05).toFixed(3)})`;
    ctx.fillRect(rand() * canvas.width, rand() * canvas.height, 2 + rand() * 6, 2 + rand() * 6);
  }
  const frame = "#f1ece2";
  const glass = (x: number, y: number, w: number, h: number) => {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#56677b");
    g.addColorStop(1, "#27313d");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  };
  const shadowBox = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  };
  const shutters = (x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = shutter;
    ctx.fillRect(x - w / 2 - 2, y, w / 2, h);
    ctx.fillRect(x + w + 2, y, w / 2, h);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    for (let k = 4; k < h; k += 5) {
      ctx.fillRect(x - w / 2 - 2, y + k, w / 2, 1);
      ctx.fillRect(x + w + 2, y + k, w / 2, 1);
    }
  };
  const cell = (c: number, draw: (x0: number, y0: number) => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect((c % 3) * S, Math.floor(c / 3) * S, S, S);
    ctx.clip();
    draw((c % 3) * S, Math.floor(c / 3) * S);
    ctx.restore();
  };
  // Window with open shutters and a sill.
  cell(CELL.window, (x0, y0) => {
    const w = 40;
    const h = 62;
    const x = x0 + (S - w) / 2;
    const y = y0 + 26;
    shutters(x, y, w, h);
    shadowBox(x, y, w, h);
    ctx.fillStyle = frame;
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    glass(x, y, w, h);
    ctx.fillStyle = frame;
    ctx.fillRect(x + w / 2 - 2, y, 4, h);
    ctx.fillStyle = "#cfc6b6";
    ctx.fillRect(x - 8, y + h + 3, w + 16, 6);
  });
  // French window onto a balcony: slab and iron railing.
  cell(CELL.balcony, (x0, y0) => {
    const w = 44;
    const h = 92;
    const x = x0 + (S - w) / 2;
    const y = y0 + 18;
    shutters(x, y, w, h);
    shadowBox(x, y, w, h);
    ctx.fillStyle = frame;
    ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    glass(x, y, w, h);
    ctx.fillStyle = frame;
    ctx.fillRect(x + w / 2 - 2, y, 4, h);
    ctx.fillStyle = "#b9b1a3";
    ctx.fillRect(x0 + 18, y0 + 108, S - 36, 8);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x0 + 18, y0 + 116, S - 36, 5);
    ctx.fillStyle = "#2b2a28";
    ctx.fillRect(x0 + 18, y0 + 76, S - 36, 3);
    for (let k = x0 + 20; k < x0 + S - 18; k += 7) ctx.fillRect(k, y0 + 76, 2, 32);
  });
  // Front door: panelled wood in a stone surround, a step, a lamp.
  cell(CELL.door, (x0, y0) => {
    const w = 40;
    const h = 92;
    const x = x0 + (S - w) / 2;
    const y = y0 + S - h - 4;
    ctx.fillStyle = "#c8bfae";
    ctx.fillRect(x - 7, y - 7, w + 14, h + 7);
    const wood = ["#5a3a24", "#6e4a2c", "#3e4a3a", "#5b2e2a"][Math.floor(rand() * 4)];
    ctx.fillStyle = wood;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(x + 5, y + 8, w / 2 - 8, h / 2 - 12);
    ctx.fillRect(x + w / 2 + 3, y + 8, w / 2 - 8, h / 2 - 12);
    ctx.fillRect(x + 5, y + h / 2 + 4, w / 2 - 8, h / 2 - 12);
    ctx.fillRect(x + w / 2 + 3, y + h / 2 + 4, w / 2 - 8, h / 2 - 12);
    ctx.fillStyle = "#d8c27a";
    ctx.fillRect(x + w - 8, y + h / 2, 3, 3);
    ctx.fillStyle = "#9d968a";
    ctx.fillRect(x - 10, y0 + S - 4, w + 20, 4);
    ctx.fillStyle = "#2b2a28";
    ctx.fillRect(x + w + 12, y + 6, 6, 10);
  });
  // Shopfront: wide glass under a striped awning and a sign band.
  cell(CELL.shop, (x0, y0) => {
    const awning = ["#a8322c", "#2f6b4f", "#2f4f86", "#c7802a"][Math.floor(rand() * 4)];
    ctx.fillStyle = "#3a3632";
    ctx.fillRect(x0 + 6, y0 + 14, S - 12, 16);
    // Lettering: a word of uneven letters, centred on the board.
    ctx.fillStyle = "#efe6cf";
    const letters = 4 + Math.floor(rand() * 4);
    let lx = x0 + S / 2 - letters * 5;
    for (let k = 0; k < letters; k++) {
      const lw = 5 + Math.floor(rand() * 4);
      ctx.fillRect(lx, y0 + 18 + Math.floor(rand() * 2), lw, 8);
      lx += lw + 3;
    }
    for (let k = 0; k < 8; k++) {
      ctx.fillStyle = k % 2 ? "#f2ede2" : awning;
      ctx.beginPath();
      ctx.moveTo(x0 + 4 + (k * (S - 8)) / 8, y0 + 32);
      ctx.lineTo(x0 + 4 + ((k + 1) * (S - 8)) / 8, y0 + 32);
      ctx.lineTo(x0 + 4 + ((k + 1) * (S - 8)) / 8, y0 + 48);
      ctx.lineTo(x0 + 4 + (k * (S - 8)) / 8, y0 + 48);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(x0 + 6, y0 + 48, S - 12, 6);
    ctx.fillStyle = "#4a4640";
    ctx.fillRect(x0 + 8, y0 + 50, S - 16, S - 54);
    glass(x0 + 12, y0 + 54, S - 50, S - 62);
    ctx.fillStyle = "rgba(255,240,200,0.25)";
    ctx.fillRect(x0 + 16, y0 + 70, S - 58, 30);
    glass(x0 + S - 34, y0 + 54, 22, S - 58);
  });
  // Garage: a ribbed roller door.
  cell(CELL.garage, (x0, y0) => {
    const w = 92;
    const h = 82;
    const x = x0 + (S - w) / 2;
    const y = y0 + S - h;
    ctx.fillStyle = "#c8bfae";
    ctx.fillRect(x - 5, y - 5, w + 10, h + 5);
    ctx.fillStyle = "#8a8a84";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    for (let k = y + 4; k < y + h; k += 6) ctx.fillRect(x, k, w, 2);
  });
  // Plain wall with a small window (sides, backs).
  cell(CELL.plain, (x0, y0) => {
    const w = 26;
    const h = 30;
    const x = x0 + (S - w) / 2;
    const y = y0 + 40;
    shadowBox(x, y, w, h);
    ctx.fillStyle = frame;
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    glass(x, y, w, h);
    ctx.fillStyle = "#2b2a28";
    for (let k = x + 3; k < x + w; k += 6) ctx.fillRect(k, y, 1.5, h);
  });
  return canvas;
}

function buildingMaterials(): Materials {
  if (materials) return materials;
  const rand = mulberry32(11);
  const walls = PLASTERS.map((plaster, i) => {
    const mat = new THREE.MeshStandardMaterial({ map: canvasTexture(paintAtlas(plaster, SHUTTERS[i % SHUTTERS.length], rand), false), roughness: 0.9 });
    return mat;
  });
  // Rough stone for plinths, paving slabs for the pavement: small repeating canvases.
  const noise = (base: string, lines: (ctx: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 160; i++) {
      ctx.fillStyle = `rgba(0,0,0,${(rand() * 0.12).toFixed(3)})`;
      ctx.fillRect(rand() * 64, rand() * 64, 2 + rand() * 5, 2 + rand() * 5);
    }
    lines(ctx);
    return canvasTexture(c, true);
  };
  const plinth = new THREE.MeshStandardMaterial({
    map: noise("#9a9182", (ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      for (let y = 0; y < 64; y += 16) ctx.fillRect(0, y, 64, 2);
      for (let y = 0; y < 64; y += 16) for (let x = (y / 16) % 2 ? 0 : 16; x < 64; x += 32) ctx.fillRect(x, y, 2, 16);
    }),
    roughness: 1,
  });
  const pavement = new THREE.MeshStandardMaterial({
    map: noise("#b8b2a6", (ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      for (let k = 0; k < 64; k += 32) {
        ctx.fillRect(0, k, 64, 1);
        ctx.fillRect(k, 0, 1, 64);
      }
    }),
    roughness: 0.95,
  });
  const roof = new THREE.MeshStandardMaterial({ color: "#a39a8c", roughness: 1 });
  const tiles = new THREE.MeshStandardMaterial({
    map: noise("#b0603f", (ctx) => {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 0; y < 64; y += 8) ctx.fillRect(0, y, 64, 2);
      for (let x = 0; x < 64; x += 8) ctx.fillRect(x, 0, 1, 64);
    }),
    roughness: 0.9,
  });
  materials = { walls, plinth, roof, tiles, pavement };
  for (const m of [...walls, plinth, roof, tiles, pavement]) {
    m.userData.shared = true;
    // Walls are laid out from both sides of the road, mirrored: lit from either face.
    m.side = THREE.DoubleSide;
  }
  return materials;
}

/** Collects quads and triangles into one geometry per material. */
class Builder {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** A quad a-b-c-d (counter-clockwise seen from outside) with texture corners in the same order. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: [number, number, number, number]) {
    const [u0, v0, u1, v1] = uv;
    const n = this.pos.length / 3;
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, uvs: [number, number, number, number, number, number]) {
    const n = this.pos.length / 3;
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...uvs);
    this.idx.push(n, n + 1, n + 2);
  }
  mesh(mat: THREE.Material): THREE.Mesh | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.kind = "building";
    return m;
  }
}

/** The atlas rectangle of a cell, as [u0, v0, u1, v1] with v up. */
function cellUv(c: Cell): [number, number, number, number] {
  const col = c % 3;
  const row = Math.floor(c / 3);
  const e = 0.004;
  return [col / 3 + e, 1 - (row + 1) / 2 + e, (col + 1) / 3 - e, 1 - row / 2 - e];
}

/**
 * Houses along the urban stretches of a route, standing on `heightAt`, and the pavements in
 * front of them. `roadDistance(x, z)` is the distance to the nearest point of the route
 * anywhere: no house or pavement goes where another part of the road (a tight bend in a
 * village, the next leg of a street) would run through it.
 */
export function buildings(
  route: Route,
  ranges: UrbanRange[],
  heightAt: (x: number, z: number) => number,
  roadWidth: number,
  roadDistance: (x: number, z: number) => number = () => Infinity,
): THREE.Group {
  const group = new THREE.Group();
  const mats = buildingMaterials();
  const sampler = new RouteSampler(route);
  const rand = mulberry32(2024);
  const walls = mats.walls.map(() => new Builder());
  const plinth = new Builder();
  const roof = new Builder();
  const tiles = new Builder();
  const pave = new Builder();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (const r of ranges) {
    const village = r.style === "village";
    const front = roadWidth / 2 + (village ? VILLAGE_PAVEMENT_M : PAVEMENT_M);
    for (const side of [-1, 1]) {
      // The pavement: a kerbed strip of slabs along the road, its top KERB_M above the road.
      for (let d = r.from; d < r.to; d += 2) {
        const a = sampler.pose(d);
        const b = sampler.pose(Math.min(r.to, d + 2));
        const off = (p: typeof a, o: number, dy: number) => V(p.x - p.dz * side * o, p.y + dy, p.z + p.dx * side * o);
        const inner = roadWidth / 2 + 0.05;
        const [ai, bi, ao, bo] = [off(a, inner, KERB_M), off(b, inner, KERB_M), off(a, front + 0.6, KERB_M), off(b, front + 0.6, KERB_M)];
        // On the inside of a tight bend the strip would fold over the road: left out there.
        if (roadDistance(ao.x, ao.z) < front - 0.3 || roadDistance(bo.x, bo.z) < front - 0.3) continue;
        const u = d / 2;
        const top = side > 0 ? [ai, bi, bo, ao] : [bi, ai, ao, bo];
        pave.quad(top[0], top[1], top[2], top[3], [u, 0, u + 1, (front - roadWidth / 2) / 2]);
        // Kerb face down to the road, and the outer face down into the ground.
        const ki = [off(a, inner, -0.05), off(b, inner, -0.05)];
        if (side > 0) pave.quad(bi, ai, ki[0], ki[1], [u, 0, u + 1, 0.1]);
        else pave.quad(ai, bi, ki[1], ki[0], [u, 0, u + 1, 0.1]);
        const ko = [off(a, front + 0.6, -1.5), off(b, front + 0.6, -1.5)];
        if (side > 0) pave.quad(ao, bo, ko[1], ko[0], [u, 0, u + 1, 0.8]);
        else pave.quad(bo, ao, ko[0], ko[1], [u, 0, u + 1, 0.8]);
      }

      let d = r.from + rand() * 6;
      while (d < r.to - 4) {
        const bays = 2 + Math.floor(rand() * 4);
        const w = bays * BAY_M;
        const depth = 9 + rand() * 7;
        const floors = Math.min(r.floors[1], r.floors[0] + Math.floor(rand() * (r.floors[1] - r.floors[0] + 1)));
        const pose = sampler.pose(d + w / 2);
        d += w + (rand() < 0.6 ? 0.2 : 2 + rand() * 6);
        if (d > r.to) break;
        // House frame: x along the road (direction of travel), z away from it.
        const ax = pose.dx;
        const az = pose.dz;
        const nx = -pose.dz * side;
        const nz = pose.dx * side;
        const setback = front + 0.3 + rand() * 0.4;
        const at = (u: number, v: number, y: number) => V(pose.x + ax * u + nx * (setback + v), y, pose.z + az * u + nz * (setback + v));
        const ground = (u: number, v: number) => {
          const p = at(u, v, 0);
          return heightAt(p.x, p.z);
        };
        // The footprint must keep clear of the road and its pavement everywhere.
        let clear = true;
        for (let u = -w / 2; u <= w / 2 + 0.01 && clear; u += Math.min(2, w / 2)) {
          for (let v = 0; v <= depth + 0.01 && clear; v += depth / 3) {
            const p = at(u, v, 0);
            if (roadDistance(p.x, p.z) < front - 0.2) clear = false;
          }
        }
        if (!clear) continue;
        const corners = [ground(-w / 2, 0), ground(w / 2, 0), ground(-w / 2, depth), ground(w / 2, depth)];
        const lo = Math.min(...corners);
        const hi = Math.max(...corners);
        if (hi - lo > 6) continue;
        // The ground floor starts at the street (the pavement's top) or the higher front corner.
        const streetY = pose.y + KERB_M;
        const floor0 = Math.max(streetY, corners[0], corners[1]) + 0.1;
        const base = lo - 1.5;
        const eaves = floor0 + GROUND_FLOOR_M + (floors - 1) * FLOOR_M;
        const colour = village ? WHITES[Math.floor(rand() * WHITES.length)] : Math.floor(rand() * walls.length);
        const W = walls[colour];
        // The four walls, each from its left corner seen from outside: front (to the road), right, back, left.
        const faces: { a: [number, number]; b: [number, number]; front: boolean }[] = [
          { a: [w / 2, 0], b: [-w / 2, 0], front: true },
          { a: [-w / 2, 0], b: [-w / 2, depth], front: false },
          { a: [-w / 2, depth], b: [w / 2, depth], front: false },
          { a: [w / 2, depth], b: [w / 2, 0], front: false },
        ];
        // The mirror image on the left of the road: walls wind the other way.
        const flip = side < 0;
        // What the street floor holds, bay by bay.
        const shopRow = rand() < (village ? 0.12 : 0.45);
        const groundCells: Cell[] = [];
        for (let k = 0; k < bays; k++) {
          const t = rand();
          groundCells.push(shopRow && t < 0.7 ? CELL.shop : k === Math.floor(bays / 2) ? CELL.door : t < 0.18 ? CELL.garage : t < 0.35 ? CELL.door : CELL.window);
        }
        if (!groundCells.includes(CELL.door) && !groundCells.includes(CELL.shop)) groundCells[0] = CELL.door;
        const balconies = rand() < (village ? 0.3 : 0.5);
        for (const f of faces) {
          const [ua, va] = flip ? f.b : f.a;
          const [ub, vb] = flip ? f.a : f.b;
          const len = Math.hypot(ub - ua, vb - va);
          const n = Math.max(1, Math.round(len / BAY_M));
          for (let k = 0; k < n; k++) {
            const t0 = k / n;
            const t1 = (k + 1) / n;
            const u0 = ua + (ub - ua) * t0;
            const v0 = va + (vb - va) * t0;
            const u1 = ua + (ub - ua) * t1;
            const v1 = va + (vb - va) * t1;
            // Plinth: from below the ground up to the ground floor.
            plinth.quad(at(u0, v0, base), at(u1, v1, base), at(u1, v1, floor0), at(u0, v0, floor0), [0, 0, (len / n) / 2, (floor0 - base) / 2]);
            // Ground floor: on the street side its cells; elsewhere a small window, or blank where the ground rises against the wall.
            const bayGround = Math.max(ground(u0, v0), ground(u1, v1));
            const frontIndex = flip ? n - 1 - k : k;
            const cell: Cell = f.front ? groundCells[Math.min(groundCells.length - 1, frontIndex)] : CELL.plain;
            if (!f.front && bayGround > floor0 + 0.4) {
              // A plain stretch of plaster: the cell's top corner, where there is no window.
              const [cu0, , cu1, cv1] = cellUv(CELL.plain);
              W.quad(at(u0, v0, floor0), at(u1, v1, floor0), at(u1, v1, floor0 + GROUND_FLOOR_M), at(u0, v0, floor0 + GROUND_FLOOR_M), [cu0, cv1 - 0.04, cu1, cv1 - 0.01]);
            } else {
              W.quad(at(u0, v0, floor0), at(u1, v1, floor0), at(u1, v1, floor0 + GROUND_FLOOR_M), at(u0, v0, floor0 + GROUND_FLOOR_M), cellUv(cell));
            }
            // Upper floors.
            for (let fl = 1; fl < floors; fl++) {
              const y0 = floor0 + GROUND_FLOOR_M + (fl - 1) * FLOOR_M;
              const c: Cell = f.front ? (balconies && fl === 1 ? CELL.balcony : CELL.window) : (k + fl) % 2 ? CELL.plain : CELL.window;
              W.quad(at(u0, v0, y0), at(u1, v1, y0), at(u1, v1, y0 + FLOOR_M), at(u0, v0, y0 + FLOOR_M), cellUv(c));
            }
          }
        }
        // Cornice: a stone band sticking out 0.25 m round the top.
        const o = 0.25;
        const ring: [number, number][] = flip
          ? [
              [-w / 2 - o, -o],
              [w / 2 + o, -o],
              [w / 2 + o, depth + o],
              [-w / 2 - o, depth + o],
            ]
          : [
              [w / 2 + o, -o],
              [-w / 2 - o, -o],
              [-w / 2 - o, depth + o],
              [w / 2 + o, depth + o],
            ];
        for (let k = 0; k < 4; k++) {
          const [u0, v0] = ring[k];
          const [u1, v1] = ring[(k + 1) % 4];
          plinth.quad(at(u0, v0, eaves), at(u1, v1, eaves), at(u1, v1, eaves + 0.35), at(u0, v0, eaves + 0.35), [0, 0, 4, 0.2]);
        }
        if (floors <= 2 && rand() < (village ? 0.85 : 0.55)) {
          // Gable roof of clay tiles, ridge along the road, 25°.
          const rise = (depth / 2 + o) * Math.tan((25 * Math.PI) / 180);
          const y = eaves + 0.35;
          const [p0, p1, p2, p3] = ring.map(([u, v]) => at(u, v, y));
          const ridgeA = at(ring[0][0], depth / 2, y + rise);
          const ridgeB = at(ring[1][0], depth / 2, y + rise);
          // Front slope p0-p1 up to the ridge, back slope p2-p3; gable ends in plaster.
          tiles.quad(p0, p1, ridgeB, ridgeA, [0, 0, w / 2, depth / 3]);
          tiles.quad(p2, p3, ridgeA, ridgeB, [0, 0, w / 2, depth / 3]);
          const [cu0, , cu1, cv1] = cellUv(CELL.plain);
          const pu: [number, number, number, number, number, number] = [cu0, cv1 - 0.04, cu1, cv1 - 0.04, (cu0 + cu1) / 2, cv1 - 0.01];
          W.tri(p1, p2, ridgeB, pu);
          W.tri(p3, p0, ridgeA, pu);
        } else {
          // Flat roof with a low parapet.
          const y = eaves + 0.35;
          const [p0, p1, p2, p3] = ring.map(([u, v]) => at(u, v, y - 0.25));
          roof.quad(p3, p2, p1, p0, [0, 0, 1, 1]);
          for (let k = 0; k < 4; k++) {
            const [u0, v0] = ring[k];
            const [u1, v1] = ring[(k + 1) % 4];
            plinth.quad(at(u0, v0, y), at(u1, v1, y), at(u1, v1, y + 0.8), at(u0, v0, y + 0.8), [0, 0, 4, 0.4]);
          }
        }
      }
    }
  }
  for (const [b, m] of [...walls.map((b, i) => [b, mats.walls[i]] as const), [plinth, mats.plinth] as const, [roof, mats.roof] as const, [tiles, mats.tiles] as const, [pave, mats.pavement] as const]) {
    const mesh = b.mesh(m);
    if (mesh) group.add(mesh);
  }
  return group;
}

