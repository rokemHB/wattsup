// Trees and bushes as the games do them: a trunk and a few crossed cards cut
// out of a painted foliage texture, instanced per kind. Far better silhouettes
// than spheres and cones, a fraction of the triangles, one draw call per kind
// and tile. The atlas is painted once on a canvas: no image files to ship.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { mulberry32 } from "./noise";

export type TreeKind = "pine" | "round" | "cypress" | "bush";

const ATLAS = 1024;
const CELL = ATLAS / 2;
/** Where each kind sits in the atlas (column, row of a 2×2 grid). */
const SLOT: Record<TreeKind, [number, number]> = { pine: [0, 0], round: [1, 0], cypress: [0, 1], bush: [1, 1] };
/** Bark lives in a small patch in the cypress cell's unused left margin. */
const BARK = { u0: 0.005, v0: 0.3, u1: 0.06, v1: 0.49 };

/** Card width and height in metres at size 1, and how far up the trunk reaches before the cards hide it. */
const SHAPE: Record<TreeKind, { w: number; h: number; trunk: number; trunkR: number }> = {
  pine: { w: 9, h: 9, trunk: 4.2, trunkR: 0.28 },
  round: { w: 7, h: 6.5, trunk: 2.2, trunkR: 0.26 },
  cypress: { w: 2.6, h: 8.5, trunk: 0.8, trunkR: 0.14 },
  bush: { w: 2.6, h: 1.7, trunk: 0, trunkR: 0 },
};

/**
 * Multiplies every foliage instance's tint (linear light). A real canopy reflects 8-10 %
 * of the light, darkened by its own inner shadows; these cards all face up into full sun
 * and came out as bright as the ground, a spring-lawn green next to the dark Aleppo pines
 * and holm oaks of the Ma-10 in photos. Chosen side by side with those photos.
 */
export const CANOPY_SHADE = 0.5;

let atlas: THREE.CanvasTexture | null = null;
let material: THREE.MeshStandardMaterial | null = null;
let depthMaterial: THREE.MeshDepthMaterial | null = null;
const geometries = new Map<string, THREE.BufferGeometry>();

/** The foliage material: alpha-cut (no sorting), lit as a canopy from above, shared by every tile. */
export function foliageMaterial(): THREE.MeshStandardMaterial {
  if (!material) {
    material = new THREE.MeshStandardMaterial({ map: foliageAtlas(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 });
    // Every card's normal points up (a canopy lit from above). Three flips the
    // normal on back faces of a double-sided material, which would turn half the
    // cards toward the ground and leave them dark: keep it up on both faces.
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""));
    };
    material.customProgramCacheKey = () => "foliage-up";
    material.userData.shared = true;
  }
  return material;
}

/** Shadows of the cards follow their cut-out, not their rectangle. */
export function foliageDepthMaterial(): THREE.MeshDepthMaterial {
  if (!depthMaterial) {
    depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: foliageAtlas(), alphaTest: 0.5, side: THREE.DoubleSide });
    depthMaterial.userData.shared = true;
  }
  return depthMaterial;
}

/**
 * A tree of this kind at size 1, standing on the origin: trunk, three crossed cards and a
 * top card; `lite`, for trees a few hundred metres off, is two crossed cards only.
 */
export function treeGeometry(kind: TreeKind, lite = false): THREE.BufferGeometry {
  const key = lite ? `${kind}-lite` : kind;
  let geo = geometries.get(key);
  if (geo) return geo;
  const { w, h, trunk, trunkR } = SHAPE[kind];
  const [sc, sr] = SLOT[kind];
  const u0 = sc / 2;
  const v0 = 1 - (sr + 1) / 2;
  const parts: THREE.BufferGeometry[] = [];
  const card = (rotY: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.translate(0, h / 2, 0);
    g.rotateY(rotY);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) / 2, v0 + uv.getY(i) / 2);
    return g;
  };
  if (lite) {
    parts.push(card(0), card(Math.PI / 2));
    geo = mergeGeometries(parts, false)!;
    const ln = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < ln.count; i++) ln.setXYZ(i, 0, 1, 0);
    geo.userData.shared = true;
    geometries.set(key, geo);
    return geo;
  }
  for (let k = 0; k < 3; k++) parts.push(card((k * Math.PI) / 3));
  // A horizontal card at two thirds of the height, for the drone's view from above.
  const top = new THREE.PlaneGeometry(w * 0.9, w * 0.9);
  top.rotateX(-Math.PI / 2);
  top.translate(0, h * 0.62, 0);
  const tuv = top.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, u0 + tuv.getX(i) / 2, v0 + tuv.getY(i) / 2);
  parts.push(top);
  if (trunk > 0) {
    const t = new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunk, 6, 1, true);
    t.translate(0, trunk / 2 - 0.1, 0);
    const uv = t.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, BARK.u0 + uv.getX(i) * (BARK.u1 - BARK.u0), BARK.v0 + uv.getY(i) * (BARK.v1 - BARK.v0));
    parts.push(t);
  }
  geo = mergeGeometries(parts, false)!;
  // Lit as one canopy from above: a card facing away from the sun would otherwise go dark and stripe the tree.
  const n = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  geo.userData.shared = true;
  geometries.set(key, geo);
  return geo;
}

/** The atlas: four painted plants and a bark patch. */
function foliageAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(7);
  const tuft = (x: number, y: number, r: number, color: string, squash = 0.6) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * squash, (rand() - 0.5) * 0.8, 0, Math.PI * 2);
    ctx.fill();
  };
  const shade = (base: [number, number, number], light: number, jitter = 12) => {
    const j = (rand() - 0.5) * jitter;
    const [r, g, b] = base.map((c) => Math.max(0, Math.min(255, Math.round(c * light + j))));
    return `rgb(${r},${g},${b})`;
  };
  const trunkShape = (cx: number, yTop: number, yBase: number, wBase: number, wTop: number) => {
    ctx.fillStyle = "#4a3521";
    ctx.beginPath();
    ctx.moveTo(cx - wBase / 2, yBase);
    ctx.lineTo(cx + wBase / 2, yBase);
    ctx.lineTo(cx + wTop / 2, yTop);
    ctx.lineTo(cx - wTop / 2, yTop);
    ctx.fill();
  };
  const branch = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    ctx.strokeStyle = "#4f3a26";
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  /**
   * Fills a crown with tufts: `inside(u, v)` says whether a point of the cell
   * (u across, v down from the top, both 0..1) is crown; lower tufts are
   * drawn darker, upper ones lighter, so the crown reads as lit from above.
   */
  const crown = (cx0: number, cy0: number, inside: (u: number, v: number) => boolean, count: number, base: [number, number, number], rMin: number, rMax: number, squash: number) => {
    const pts: [number, number][] = [];
    while (pts.length < count) {
      const u = rand();
      const v = rand();
      if (inside(u, v)) pts.push([u, v]);
    }
    // Back to front: lower first.
    pts.sort((a, b) => b[1] - a[1]);
    for (const [u, v] of pts) {
      const light = 0.75 + 0.65 * (1 - v) + (rand() - 0.5) * 0.2;
      tuft(cx0 + u * CELL, cy0 + v * CELL, rMin + rand() * (rMax - rMin), shade(base, light), squash);
    }
  };
  const cell = (kind: TreeKind) => {
    const [c, r] = SLOT[kind];
    return [c * CELL, r * CELL] as const;
  };

  // Aleppo pine: a bare trunk, a few branches, an uneven umbrella crown in the upper half.
  {
    const [x, y] = cell("pine");
    trunkShape(x + CELL * 0.5, y + CELL * 0.35, y + CELL, CELL * 0.07, CELL * 0.035);
    branch(x + CELL * 0.5, y + CELL * 0.5, x + CELL * 0.25, y + CELL * 0.3, 6);
    branch(x + CELL * 0.5, y + CELL * 0.45, x + CELL * 0.74, y + CELL * 0.28, 6);
    branch(x + CELL * 0.5, y + CELL * 0.4, x + CELL * 0.6, y + CELL * 0.15, 5);
    const lobes: [number, number, number, number][] = [
      [0.5, 0.27, 0.3, 0.17],
      [0.28, 0.33, 0.2, 0.13],
      [0.72, 0.31, 0.22, 0.14],
      [0.55, 0.14, 0.17, 0.1],
      [0.4, 0.42, 0.16, 0.09],
    ];
    const inside = (u: number, v: number) => lobes.some(([lu, lv, ru, rv]) => ((u - lu) / ru) ** 2 + ((v - lv) / rv) ** 2 < 1);
    crown(x, y, inside, 900, [66, 104, 56], 7, 15, 0.55);
  }
  // Holm oak: a short trunk under a dense round crown.
  {
    const [x, y] = cell("round");
    trunkShape(x + CELL * 0.5, y + CELL * 0.55, y + CELL, CELL * 0.075, CELL * 0.04);
    const inside = (u: number, v: number) => ((u - 0.5) / 0.43) ** 2 + ((v - 0.4) / 0.36) ** 2 < 1 + (rand() - 0.5) * 0.15;
    crown(x, y, inside, 1100, [76, 110, 54], 7, 14, 0.75);
  }
  // Cypress: a tall dark spindle; bark patch in its left margin.
  {
    const [x, y] = cell("cypress");
    trunkShape(x + CELL * 0.5, y + CELL * 0.8, y + CELL, CELL * 0.05, CELL * 0.03);
    const inside = (u: number, v: number) => {
      const half = 0.19 * Math.sin(Math.PI * Math.min(1, (v + 0.02) / 0.95)) ** 0.6;
      return v < 0.93 && Math.abs(u - 0.5) < half;
    };
    crown(x, y, inside, 700, [52, 90, 54], 5, 10, 0.9);
    // Bark: vertical streaks.
    const bx0 = BARK.u0 * ATLAS;
    const by0 = (1 - BARK.v1) * ATLAS;
    const bw = (BARK.u1 - BARK.u0) * ATLAS;
    const bh = (BARK.v1 - BARK.v0) * ATLAS;
    ctx.fillStyle = "#5a4330";
    ctx.fillRect(bx0, by0, bw, bh);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = shade([74, 54, 36], 0.7 + rand() * 0.7, 20);
      const sx = bx0 + rand() * bw;
      ctx.fillRect(sx, by0 + rand() * bh * 0.5, 2 + rand() * 3, bh * (0.3 + rand() * 0.5));
    }
  }
  // Bush: low, wide, grey-green.
  {
    const [x, y] = cell("bush");
    const inside = (u: number, v: number) => ((u - 0.5) / 0.46) ** 2 + ((v - 0.62) / 0.36) ** 2 < 1 + (rand() - 0.5) * 0.2 && v < 0.97;
    crown(x, y, inside, 900, [108, 124, 72], 8, 16, 0.7);
  }
  atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 2;
  atlas.userData.shared = true;
  return atlas;
}
