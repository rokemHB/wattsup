// Houses along a road: boxes with a painted facade (plaster, windows, sills)
// and a flat roof, placed on both sides of the stretches the world marks as
// urban. A handful of merged meshes: one per facade colour and one for the
// roofs, so a town costs a few draw calls.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Route } from "../types";
import { mulberry32 } from "./noise";
import { RouteSampler } from "./route";

export interface UrbanRange {
  /** Metres along the route. */
  from: number;
  to: number;
  /** Fewest and most storeys. */
  floors: [number, number];
}

const FLOOR_M = 3;
/** Metres of facade one repeat of the texture covers (one window). */
const TILE_W = 3.6;
const PLASTERS = ["#ece6d8", "#dcc49a", "#d9a37c", "#e8d9c4"];

let facades: THREE.MeshStandardMaterial[] | null = null;
let roofMat: THREE.MeshStandardMaterial | null = null;

/** One facade texture per plaster colour: a window with frame and sill on a mottled wall. */
function facadeMaterials(): THREE.MeshStandardMaterial[] {
  if (facades) return facades;
  const rand = mulberry32(11);
  facades = PLASTERS.map((plaster) => {
    const w = 192;
    const h = 160;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = plaster;
    ctx.fillRect(0, 0, w, h);
    // Mottling.
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = `rgba(0,0,0,${(rand() * 0.06).toFixed(3)})`;
      ctx.fillRect(rand() * w, rand() * h, 2 + rand() * 6, 2 + rand() * 6);
    }
    // Window: frame, glass with a light gradient, a sill and a shadow under the lintel.
    const x0 = 68;
    const y0 = 34;
    const ww = 56;
    const wh = 84;
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(x0 - 4, y0 - 4, ww + 8, wh + 8);
    ctx.fillStyle = "#f4efe6";
    ctx.fillRect(x0 - 3, y0 - 3, ww + 6, wh + 6);
    const glass = ctx.createLinearGradient(0, y0, 0, y0 + wh);
    glass.addColorStop(0, "#5a6b80");
    glass.addColorStop(1, "#2e3a4a");
    ctx.fillStyle = glass;
    ctx.fillRect(x0, y0, ww, wh);
    ctx.fillStyle = "#f4efe6";
    ctx.fillRect(x0 + ww / 2 - 2, y0, 4, wh); // mullion
    ctx.fillRect(x0, y0 + wh * 0.45, ww, 3); // transom
    ctx.fillStyle = "#cfc6b6";
    ctx.fillRect(x0 - 8, y0 + wh + 3, ww + 16, 6); // sill
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    mat.userData.shared = true;
    return mat;
  });
  roofMat = new THREE.MeshStandardMaterial({ color: "#8a7f74", roughness: 1 });
  roofMat.userData.shared = true;
  return facades;
}

/** A wall of `len` by `h` metres standing on the local x axis at `z` offset, facing `outward`. */
function wall(len: number, h: number, offsetX: number, offsetZ: number, rotY: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(len, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * len) / TILE_W, (uv.getY(i) * h) / FLOOR_M);
  g.translate(0, h / 2, 0);
  g.rotateY(rotY);
  g.translate(offsetX, 0, offsetZ);
  return g;
}

/** Houses along the urban stretches of a route, standing on `heightAt`. */
export function buildings(route: Route, ranges: UrbanRange[], heightAt: (x: number, z: number) => number, roadWidth: number): THREE.Group {
  const group = new THREE.Group();
  const mats = facadeMaterials();
  const sampler = new RouteSampler(route);
  const rand = mulberry32(2024);
  const byColour: THREE.BufferGeometry[][] = mats.map(() => []);
  const roofs: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (const r of ranges) {
    for (const side of [-1, 1]) {
      let d = r.from + rand() * 12;
      while (d < r.to) {
        const w = 9 + rand() * 11; // along the road
        const depth = 8 + rand() * 8;
        const floors = Math.min(r.floors[1], r.floors[0] + Math.floor(rand() * (r.floors[1] - r.floors[0] + 1)));
        const h = floors * FLOOR_M;
        const pose = sampler.pose(d + w / 2);
        // Right of travel is (-dz, dx) in an x-east, z-south frame.
        const nx = -pose.dz * side;
        const nz = pose.dx * side;
        const setback = roadWidth / 2 + 3 + rand() * 3 + depth / 2;
        const cx = pose.x + nx * setback;
        const cz = pose.z + nz * setback;
        // Ground under the four corners: skip a plot that is too steep for a house.
        const ax = pose.dx;
        const az = pose.dz;
        const corners = [
          [cx + (ax * w) / 2 + (nx * depth) / 2, cz + (az * w) / 2 + (nz * depth) / 2],
          [cx - (ax * w) / 2 + (nx * depth) / 2, cz - (az * w) / 2 + (nz * depth) / 2],
          [cx + (ax * w) / 2 - (nx * depth) / 2, cz + (az * w) / 2 - (nz * depth) / 2],
          [cx - (ax * w) / 2 - (nx * depth) / 2, cz - (az * w) / 2 - (nz * depth) / 2],
        ].map(([x, z]) => heightAt(x, z));
        const lo = Math.min(...corners);
        const hi = Math.max(...corners);
        d += w + 2 + rand() * 9;
        if (hi - lo > 5) continue;
        const base = lo - 1.5;
        const yaw = Math.atan2(-az, ax);
        m.makeRotationY(yaw).setPosition(cx, base, cz);
        const parts = [wall(w, h + 1.5, 0, depth / 2, 0), wall(w, h + 1.5, 0, -depth / 2, Math.PI), wall(depth, h + 1.5, w / 2, 0, Math.PI / 2), wall(depth, h + 1.5, -w / 2, 0, -Math.PI / 2)];
        const colour = Math.floor(rand() * mats.length);
        for (const part of parts) byColour[colour].push(part.applyMatrix4(m));
        const roof = new THREE.PlaneGeometry(w, depth);
        roof.rotateX(-Math.PI / 2);
        roof.translate(0, h + 1.5, 0);
        roofs.push(roof.applyMatrix4(m));
      }
    }
  }
  const add = (geos: THREE.BufferGeometry[], mat: THREE.Material) => {
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  byColour.forEach((geos, k) => add(geos, mats[k]));
  add(roofs, roofMat!);
  return group;
}
