// Direction signs at junctions: a post with one board per road leaving the
// junction, lettered with the road number and the towns it leads to. The
// boards turn to face the camera (yaw only) so they can always be read.
//
// Each post is one mesh with one texture: the boards are painted one under the
// other on a single canvas, and the pole takes its colour from a grey strip at
// the bottom of it. On WebKit every draw call costs ~30 µs of CPU, and a post
// used to be a pole plus one call per board (a town junction: a dozen calls).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { NetworkNode, Sign } from "../types";

const BOARD_W = 3.0;
const BOARD_H = 0.56;
const CANVAS_W = 1024;
/** Board height in canvas pixels. */
const BOARD_PX = 196;
/** The grey strip under the boards that the pole and board backs are coloured from. */
const STRIP_PX = 32;
const POLE_H = 3.0;

/** Paints one direction board at canvas row `y0`. */
function paintBoard(ctx: CanvasRenderingContext2D, y0: number, sign: Sign, arrow: string) {
  const h = BOARD_PX;
  // Spanish conventional-road style: white board, black lettering, the road number in a box.
  ctx.fillStyle = "#f4f2ea";
  ctx.fillRect(0, y0, CANVAS_W, h);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, y0 + 4, CANVAS_W - 8, h - 8);
  ctx.fillStyle = "#111";
  ctx.font = "bold 110px sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(arrow, 28, y0 + h / 2);
  let x = 150;
  if (sign.ref) {
    ctx.font = "bold 72px sans-serif";
    const w = ctx.measureText(sign.ref).width + 40;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, y0 + 48, w, 100);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 6;
    ctx.strokeRect(x, y0 + 48, w, 100);
    ctx.fillStyle = "#111";
    ctx.fillText(sign.ref, x + 20, y0 + h / 2);
    x += w + 30;
  }
  ctx.font = "bold 78px sans-serif";
  const text = sign.to.slice(0, 2).join(" · ") || "";
  let size = 78;
  while (ctx.measureText(text).width > CANVAS_W - x - 30 && size > 40) {
    size -= 4;
    ctx.font = `bold ${size}px sans-serif`;
  }
  ctx.fillText(text, x, y0 + h / 2);
}

/** Which way a sign points, from the leaving edge's bearing relative to the post's facing. */
function arrowFor(angleDeg: number): string {
  const a = ((angleDeg + 540) % 360) - 180;
  if (Math.abs(a) < 30) return "↑";
  if (a > 150 || a < -150) return "↓";
  return a > 0 ? "→" : "←";
}

/** A canvas `height` px tall whose last STRIP_PX rows are the pole's grey; `paint` fills the rest. */
function postCanvas(height: number, paint: (ctx: CanvasRenderingContext2D) => void): { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = height + STRIP_PX;
  const ctx = canvas.getContext("2d")!;
  paint(ctx);
  ctx.fillStyle = "#8a8f99";
  ctx.fillRect(0, height, CANVAS_W, STRIP_PX);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // Canvas row 0 is the top: no flip, v measured downwards.
  tex.flipY = false;
  return { canvas, tex };
}

/** Maps every uv of `geo` into the canvas rows [y0, y1] (v downwards). */
function uvRows(geo: THREE.BufferGeometry, canvasH: number, y0: number, y1: number, flat = false) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const v = flat ? 0.5 : uv.getY(i);
    // PlaneGeometry has v = 1 at its top edge, which is canvas row y0.
    uv.setXY(i, flat ? 0.5 : uv.getX(i), (y0 + (1 - v) * (y1 - y0)) / canvasH);
  }
}

/** The pole, coloured from the grey strip. */
function pole(canvasH: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.05, 0.05, POLE_H, 8).toNonIndexed();
  g.translate(0, POLE_H / 2, 0);
  uvRows(g, canvasH, canvasH - STRIP_PX + 4, canvasH - 4, true);
  // Cylinder has no index after toNonIndexed; the plane boards do: make every part non-indexed to merge.
  return g;
}

function postMesh(parts: THREE.BufferGeometry[], tex: THREE.Texture): THREE.Mesh {
  const geo = mergeGeometries(
    parts.map((g) => (g.index ? g.toNonIndexed() : g)),
    false,
  )!;
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide }));
  return mesh;
}

export interface SignPost {
  group: THREE.Group;
  /** Meshes that turn to face the camera (about the pole's axis). */
  boards: THREE.Mesh[];
}

/**
 * A sign post for a junction node. `bearingOf(edge)` gives the bearing (degrees,
 * x east, z south, clockwise) in which that edge leaves the node; `facing` is
 * the bearing the post's front should face (the approach direction reversed).
 */
export function signPost(node: NetworkNode, x: number, z: number, y: number, bearingOf: (edge: number) => number, facing: number): SignPost | null {
  const signs = (node.signs ?? []).filter((s) => s.to.length || s.ref);
  if (!signs.length) return null;
  // Nothing to tell when every board would read the same (dual carriageways, slip roads).
  const key = (s: Sign) => `${s.ref ?? ""}|${s.to.join(",")}`;
  if (signs.length > 1 && signs.every((s) => key(s) === key(signs[0]))) return null;
  const shown = signs.slice(0, 3);
  const height = shown.length * BOARD_PX;
  const { canvas, tex } = postCanvas(height, (ctx) => shown.forEach((sign, i) => paintBoard(ctx, i * BOARD_PX, sign, arrowFor(bearingOf(sign.edge) - facing))));
  const parts = [pole(canvas.height)];
  shown.forEach((_, i) => {
    const board = new THREE.PlaneGeometry(BOARD_W, BOARD_H);
    uvRows(board, canvas.height, i * BOARD_PX, (i + 1) * BOARD_PX);
    board.translate(0, 2.8 - i * (BOARD_H + 0.06), 0);
    parts.push(board);
  });
  // The whole post turns about the pole, which looks the same from every side.
  const mesh = postMesh(parts, tex);
  const group = new THREE.Group();
  group.add(mesh);
  group.position.set(x, y, z);
  return { group, boards: [mesh] };
}

/** A confirmation sign between junctions: the next towns ahead with their distance in km, one board per town. */
export function confirmationPost(to: [string, number][], x: number, z: number, y: number, facingDx: number, facingDz: number): SignPost {
  const height = 110 + 100 * Math.min(2, to.length);
  const { canvas, tex } = postCanvas(height, (ctx) => {
    ctx.fillStyle = "#f4f2ea";
    ctx.fillRect(0, 0, CANVAS_W, height);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, CANVAS_W - 8, height - 8);
    ctx.fillStyle = "#111";
    ctx.textBaseline = "middle";
    to.slice(0, 2).forEach(([name, km], i) => {
      const yy = 60 + i * 100;
      ctx.font = "bold 70px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(name, 40, yy);
      ctx.textAlign = "right";
      ctx.fillText(km >= 10 ? km.toFixed(0) : km.toFixed(1), CANVAS_W - 40, yy);
    });
  });
  const h = (height / CANVAS_W) * BOARD_W;
  // The board faces the riders it is for and shows a grey back to everyone else; it does not turn.
  const front = new THREE.PlaneGeometry(BOARD_W, h);
  uvRows(front, canvas.height, 0, height);
  front.translate(0, 3.0 - h / 2, 0.01);
  const back = new THREE.PlaneGeometry(BOARD_W, h);
  uvRows(back, canvas.height, canvas.height - STRIP_PX + 4, canvas.height - 4, true);
  back.rotateY(Math.PI);
  back.translate(0, 3.0 - h / 2, -0.01);
  const mesh = postMesh([pole(canvas.height), front, back], tex);
  mesh.rotation.y = Math.atan2(facingDx, facingDz);
  const group = new THREE.Group();
  group.add(mesh);
  group.position.set(x, y, z);
  return { group, boards: [] };
}

/** Turns the boards to face the camera around the vertical axis. */
export function faceCamera(posts: SignPost[], camera: THREE.Vector3) {
  for (const p of posts) {
    const dx = camera.x - p.group.position.x;
    const dz = camera.z - p.group.position.z;
    const yaw = Math.atan2(dx, dz);
    for (const b of p.boards) b.rotation.y = yaw;
  }
}
