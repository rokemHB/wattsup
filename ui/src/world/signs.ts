// Direction signs at junctions: a post with one board per road leaving the
// junction, lettered with the road number and the towns it leads to. The
// boards turn to face the camera (yaw only) so they can always be read.
import * as THREE from "three";
import type { NetworkNode, Sign } from "../types";

const BOARD_W = 3.4;
const BOARD_H = 0.64;

function boardTexture(sign: Sign, arrow: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 196;
  const ctx = c.getContext("2d")!;
  // Spanish conventional-road style: white board, black lettering, the road number in a box.
  ctx.fillStyle = "#f4f2ea";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, c.width - 8, c.height - 8);
  ctx.fillStyle = "#111";
  ctx.font = "bold 110px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(arrow, 28, c.height / 2);
  let x = 150;
  if (sign.ref) {
    ctx.font = "bold 72px sans-serif";
    const w = ctx.measureText(sign.ref).width + 40;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, 48, w, 100);
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 6;
    ctx.strokeRect(x, 48, w, 100);
    ctx.fillStyle = "#111";
    ctx.fillText(sign.ref, x + 20, c.height / 2);
    x += w + 30;
  }
  ctx.font = "bold 78px sans-serif";
  const text = sign.to.slice(0, 2).join(" · ") || "";
  let size = 78;
  while (ctx.measureText(text).width > c.width - x - 30 && size > 40) {
    size -= 4;
    ctx.font = `bold ${size}px sans-serif`;
  }
  ctx.fillText(text, x, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Which way a sign points, from the leaving edge's bearing relative to the post's facing. */
function arrowFor(angleDeg: number): string {
  const a = ((angleDeg + 540) % 360) - 180;
  if (Math.abs(a) < 30) return "↑";
  if (a > 150 || a < -150) return "↓";
  return a > 0 ? "→" : "←";
}

export interface SignPost {
  group: THREE.Group;
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
  const group = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.0, 8), new THREE.MeshStandardMaterial({ color: "#8a8f99", roughness: 0.6, metalness: 0.6 }));
  post.position.set(0, 1.5, 0);
  post.castShadow = true;
  group.add(post);
  const boards: THREE.Mesh[] = [];
  signs.slice(0, 4).forEach((sign, i) => {
    const rel = bearingOf(sign.edge) - facing;
    const tex = boardTexture(sign, arrowFor(rel));
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), mat);
    board.position.set(0, 2.8 - i * (BOARD_H + 0.06), 0);
    board.castShadow = true;
    group.add(board);
    boards.push(board);
  });
  group.position.set(x, y, z);
  return { group, boards };
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
