// Static world geometry built once from the route: terrain, sea, lake, road,
// far mountains, clouds and vegetation. Everything is procedural.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Route } from "../types";
import { fbm, mulberry32 } from "./noise";
import { RouteSampler } from "./route";
import { gridSample, gridSlope, imageMean, OrthoSampler, type Grid, type WorldData } from "./terrain";
import { buildings } from "./buildings";
import { foliageDepthMaterial, foliageMaterial, treeGeometry } from "./trees";
import { asphaltTexture, cloudTexture, detailTexture, grassTexture, rockDetailTexture, rockNormalTexture, rockTexture, scrubDetailTexture, waterNormalTexture } from "./textures";

/** Road width in metres: a mountain road for real-world routes, a wider one for the procedural course. */
export const REAL_ROAD_WIDTH = 5.8;
export const ROAD_WIDTH = 7;
/** Height of the top road layer (the markings) above the route line. */
export const ROAD_LIFT = 0.08;
const TERRAIN_SIZE = 3400;
const TERRAIN_SEGMENTS = 240;
export const FAR_SIZE = 18000;
const FAR_SEGMENTS = 180;
const LAKE_RADIUS = 300;
export const SEA_LEVEL = 0;

export interface WorldStatics {
  group: THREE.Group;
  /** Terrain height at a ground position. */
  heightAt: (x: number, z: number) => number;
  /** Whether a ground position lies inside a road tunnel, where the terrain above does not count. */
  inTunnel?: (x: number, z: number) => boolean;
  /** Advances water and clouds. */
  animate: (dt: number) => void;
}

/** Anything that can answer "nearest road point": a route's own index or the network's. */
export interface RoadIndex {
  nearest(x: number, z: number, radius: number): { d: number; y: number; i: number; edge?: number };
}

/** Nearest route sample within a few hundred metres, through a coarse grid. */
export class RouteIndex implements RoadIndex {
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
  nearest(x: number, z: number, radius: number): { d: number; y: number; i: number } {
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = Infinity;
    let y = 0;
    let bi = -1;
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
            bi = idx;
          }
        }
      }
    }
    return { d: best, y, i: bi };
  }
}

export const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(Math.max((t - a) / (b - a), 0), 1);
  return x * x * (3 - 2 * x);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the land is in a procedural world versus a real one. */
export interface Land {
  /** Raw ground before the road is cut in. */
  height: (x: number, z: number) => number;
  /** Sea or lake: nothing grows here. */
  water: (x: number, z: number) => boolean;
  /** Steepness (rise over run) for colouring and planting. */
  slope: (x: number, z: number) => number;
}

export function buildWorld(route: Route, world?: WorldData): WorldStatics {
  return world ? buildRealWorld(route, world) : buildProceduralWorld(route);
}

/** Terrain from heightmaps: the near grid as is, the far grid around it, lowered where they overlap. */
function buildRealWorld(route: Route, world: WorldData): WorldStatics {
  const sampler = new RouteSampler(route);
  const pts = route.points;
  const index = new RouteIndex(pts);
  const group = new THREE.Group();
  const { near, far, band } = world;

  // Where the elevation model says sea, drop the ground a few metres so the
  // sea surface draws above it instead of fighting with the photo's water.
  const raw = (x: number, z: number) => {
    const h = (band ? gridSample(band, x, z) : null) ?? gridSample(near, x, z) ?? gridSample(far, x, z) ?? SEA_LEVEL - 10;
    return h <= SEA_LEVEL + 0.3 ? SEA_LEVEL - 4 : h;
  };
  const box = {
    x0: Math.min(...pts.map((p) => p.x)) - 60,
    x1: Math.max(...pts.map((p) => p.x)) + 60,
    z0: Math.min(...pts.map((p) => p.z)) - 60,
    z1: Math.max(...pts.map((p) => p.z)) + 60,
  };
  // The road is cut into the hillside and built up on embankments: inside
  // the shoulder the ground is the road bed; outside it the terrain is kept
  // between a cut slope rising from the road and a fill slope dropping from
  // it, so both meet the real ground a few metres out.
  const corridor = (x: number, z: number, h: number): number => {
    if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) return h;
    const n = index.nearest(x, z, CORRIDOR_REACH);
    return corridorHeight(h, n.d, n.y);
  };
  const heightAt = (x: number, z: number): number => corridor(x, z, raw(x, z));
  // Under the corridor strip the coarse grid is tucked away so its 10 m triangles cannot poke through.
  const tucked = (x: number, z: number): number => {
    const h = heightAt(x, z);
    if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) return h;
    const n = index.nearest(x, z, CORRIDOR_REACH);
    // Deeper on steep ground: a 10 m grid and the fine strip disagree by metres there.
    const depth = 1.2 + 3.5 * Math.min(1.5, gridSlope(near, x, z));
    return h - depth * (1 - smoothstep(CORRIDOR_REACH - 15, CORRIDOR_REACH, n.d));
  };
  const land: Land = {
    height: heightAt,
    water: (x, z) => raw(x, z) < SEA_LEVEL + 1.5,
    slope: (x, z) => gridSlope(band && gridSample(band, x, z) !== null ? band : near, x, z),
  };

  const grass = grassTexture();
  const rockTex = rockTexture();
  const detail: Detail = world.details
    ? {
        grain: detailTexture(),
        rock: patchTexture(world.details.rock),
        scrub: patchTexture(world.details.scrub),
        normal: rockNormalTexture(),
        rockScale: world.details.metres,
        scrubScale: world.details.metres,
        rockMean: imageMean(world.details.rock),
        scrubMean: imageMean(world.details.scrub),
      }
    : { grain: detailTexture(), rock: rockDetailTexture(), scrub: scrubDetailTexture(), normal: rockNormalTexture(), rockScale: 3.2, scrubScale: 2.6, rockMean: [0.5, 0.5, 0.5], scrubMean: [0.5, 0.5, 0.5] };
  let photo: ((x: number, z: number) => [number, number, number] | null) | null = null;
  const inNear = (x: number, z: number) => gridSample(near, x, z) !== null;
  // Inside the near grid the far mesh only has to stay hidden; on cliffs the two differ by tens of metres.
  const farHeight = (x: number, z: number) => (inNear(x, z) ? raw(x, z) - 60 : raw(x, z));
  if (near.ortho) {
    // Aerial imagery: one textured mesh per block of the near grid, photo on the far grid.
    const { rowEdges, colEdges, images } = near.ortho;
    // Blocks with the road in or near them get every sample; the others every
    // other one. The corridor strip carries the fine shape at the road, and
    // half the triangles is a good part of a frame on an integrated GPU.
    const sz = near.spacingZ ?? near.spacing;
    const halves: Grid = { ...near, cols: Math.floor((near.cols - 1) / 2) + 1, rows: Math.floor((near.rows - 1) / 2) + 1, spacing: near.spacing * 2, spacingZ: sz * 2 };
    for (let br = 0; br < rowEdges.length - 1; br++) {
      for (let bc = 0; bc < colEdges.length - 1; bc++) {
        const tex = imageTexture(images[br][bc]);
        const bx0 = near.x0 + colEdges[bc] * near.spacing - 400;
        const bx1 = near.x0 + colEdges[bc + 1] * near.spacing + 400;
        const bz0 = near.z0 + rowEdges[br] * sz - 400;
        const bz1 = near.z0 + rowEdges[br + 1] * sz + 400;
        const nearRoad = pts.some((p) => p.x >= bx0 && p.x <= bx1 && p.z >= bz0 && p.z <= bz1);
        const k = nearRoad ? 1 : 2;
        const g = k === 1 ? near : halves;
        const rr: [number, number] = [Math.round(rowEdges[br] / k), Math.min(g.rows - 1, Math.round(rowEdges[br + 1] / k))];
        const cc: [number, number] = [Math.round(colEdges[bc] / k), Math.min(g.cols - 1, Math.round(colEdges[bc + 1] / k))];
        group.add(gridBlockMesh(g, tucked, rr, cc, tex, detail));
      }
    }
    const sampler = new OrthoSampler(near, near.ortho);
    photo = (x, z) => sampler.colorAt(x, z);
    group.add(corridorMesh(pts, index, heightAt, near, detail.grain, photo, detail));
    if (far.ortho) {
      group.add(gridBlockMesh(far, farHeight, [0, far.rows - 1], [0, far.cols - 1], imageTexture(far.ortho.images[0][0]), detail, 0));
    } else {
      group.add(gridMesh(far, farHeight, rockTex, 520));
    }
  } else {
    group.add(gridMesh(near, tucked, grass, 18));
    group.add(corridorMesh(pts, index, heightAt, near, grass, null, null));
    group.add(gridMesh(far, farHeight, rockTex, 520));
  }

  const sea = seaMesh(FAR_SIZE * 2, (near.x0 + (near.cols * near.spacing) / 2), (near.z0 + (near.rows * near.spacing) / 2));
  group.add(sea.mesh);
  group.add(...roadMeshes(pts, route.closed, REAL_ROAD_WIDTH, true));
  group.add(parapets(pts, heightAt, REAL_ROAD_WIDTH, detail.rock));
  const clouds = cloudLayers((near.x0 + (near.cols * near.spacing) / 2), (near.z0 + (near.rows * near.spacing) / 2));
  group.add(...clouds.meshes);
  const region = { x0: near.x0, z0: near.z0, w: near.cols * near.spacing, h: near.rows * near.spacing };
  group.add(vegetation(index, heightAt, land, region, sampler, true, photo));
  if (world.urban?.length) group.add(buildings(route, world.urban, heightAt, REAL_ROAD_WIDTH));

  const animate = (dt: number) => {
    sea.animate(dt);
    clouds.animate(dt);
  };
  return { group, heightAt, animate };
}

/** How much of the aerial photo's brightness the terrain reflects under the scene's own sun. */
export const PHOTO_REFLECTANCE = 0.46;
export const SHOULDER = REAL_ROAD_WIDTH / 2 + 0.9;
/** Metres either side of the road that the corridor shapes. */
export const CORRIDOR_REACH = 46;
/** Rise over run of the cut bank above the road and the fill bank below it. */
export const CUT_SLOPE = 2.4;
export const FILL_SLOPE = 0.9;
/** Over the last metres of the reach the banks blend back into the raw ground, so a cliff above or below the road meets the corridor without a wall. */
export const CORRIDOR_BLEND_M = 14;

/**
 * The corridor field at distance `d` from the road (height `roadY` there):
 * the road bed inside the shoulder, the ground kept between a fill slope
 * dropping from the road and a cut slope rising from it outside, fading to
 * the raw ground `h` at the reach.
 */
export function corridorHeight(h: number, d: number, roadY: number): number {
  if (d > CORRIDOR_REACH) return h;
  const bed = roadY - 0.35;
  if (d <= SHOULDER) return bed;
  const out = d - SHOULDER;
  const shaped = Math.min(Math.max(h, bed - out * FILL_SLOPE), bed + out * CUT_SLOPE);
  return lerp(shaped, h, smoothstep(CORRIDOR_REACH - CORRIDOR_BLEND_M, CORRIDOR_REACH, d));
}

/** Lateral offsets of the corridor strip's cross-section, shoulder outwards. */
const CORRIDOR_OFFSETS = [0, SHOULDER, SHOULDER + 1.5, SHOULDER + 3.5, SHOULDER + 6.5, SHOULDER + 11, 24, 33, CORRIDOR_REACH];

const GROUND = {
  scrub: new THREE.Color("#73855a"),
  dryScrub: new THREE.Color("#a59c68"),
  rock: new THREE.Color("#a39b8f"),
  rockHigh: new THREE.Color("#c4bdb1"),
  sand: new THREE.Color("#d8c89a"),
};

/** Ground colour from altitude and steepness: limestone on steep and high ground, dry scrub elsewhere, sand at the shore. */
function groundColor(out: THREE.Color, x: number, y: number, z: number, slope: number): THREE.Color {
  const high = smoothstep(400, 1000, y);
  const patch = fbm(x, z, 180, 16);
  out.copy(GROUND.scrub).lerp(GROUND.dryScrub, 0.5 * fbm(x, z, 420, 15) + 0.4 * high);
  const rockiness = smoothstep(0.22, 0.55, slope + 0.3 * high + 0.3 * (patch - 0.5));
  out.lerp(high > 0.5 ? GROUND.rockHigh : GROUND.rock, rockiness);
  if (y < SEA_LEVEL + 6) out.lerp(GROUND.sand, smoothstep(SEA_LEVEL + 6, SEA_LEVEL + 1, y));
  return out;
}

/**
 * A fine strip of ground along the road, sampling the same corridor field as
 * the grid but every 5 m along and a few metres across, so banks and
 * shoulders are shaped properly. At hairpins each cross-section stops where
 * another part of the road is closer, so stacked sections never overlap.
 */
export function corridorMesh(
  pts: Route["points"],
  index: RoadIndex,
  heightAt: (x: number, z: number) => number,
  g: Grid | null,
  map: THREE.Texture,
  photo: ((x: number, z: number) => [number, number, number] | null) | null,
  detail: Detail | null,
  edgeId = -1,
  startIndex = 0,
): THREE.Mesh {
  const n = pts.length;
  const offsets = [...CORRIDOR_OFFSETS.slice(1).reverse().map((o) => -o), ...CORRIDOR_OFFSETS];
  const across = offsets.length;
  const verts = new Float32Array(n * across * 3);
  const uvs = new Float32Array(n * across * 2);
  const colors = new Float32Array(n * across * 3);
  const tmp = new THREE.Color();
  // Cross-section frames, and how far out each section owns the ground on
  // each side before another part of the road is closer (hairpins). "Another
  // part" means at least 50 m further along the road, whatever the spacing.
  const spacing = n > 1 ? Math.max(1, pts[1].distance_m - pts[0].distance_m) : 5;
  const apart = Math.max(3, Math.round(50 / spacing));
  const frames = pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)];
    const b = pts[Math.min(i + 1, n - 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    const reach = [-1, 1].map((side) => {
      let r = CORRIDOR_REACH;
      for (const o of CORRIDOR_OFFSETS) {
        const q = index.nearest(p.x + nx * o * side, p.z + nz * o * side, CORRIDOR_REACH);
        const other = q.edge !== undefined && edgeId >= 0 ? q.edge !== edgeId || Math.abs(q.i - (startIndex + i)) > apart : Math.abs(q.i - i) > apart;
        if (q.i >= 0 && other && q.d < o * 0.95) {
          r = Math.max(SHOULDER, o - 0.5 * (o - q.d));
          break;
        }
      }
      return r;
    });
    // On the inside of a bend the offsets converge: past the bend's radius they
    // would cross and the strip fold over itself (pale flat triangles at hairpins).
    const turn = Math.atan2((p.x - a.x) * (b.z - p.z) - (p.z - a.z) * (b.x - p.x), (p.x - a.x) * (b.x - p.x) + (p.z - a.z) * (b.z - p.z));
    if (Math.abs(turn) > 0.05) {
      const radius = l / 2 / Math.abs(turn);
      const inner = turn > 0 ? 1 : 0; // right turn (x east, z south): the right side is inside
      reach[inner] = Math.min(reach[inner], Math.max(SHOULDER, radius * 0.9));
    }
    return { nx, nz, reach };
  });
  // The reach may only change gradually along the road, or the strip tears into long thin triangles.
  for (let side = 0; side < 2; side++) {
    for (let i = 1; i < n; i++) frames[i].reach[side] = Math.min(frames[i].reach[side], frames[i - 1].reach[side] + 2.0);
    for (let i = n - 2; i >= 0; i--) frames[i].reach[side] = Math.min(frames[i].reach[side], frames[i + 1].reach[side] + 2.0);
  }
  for (let i = 0; i < n; i++) {
    const { nx, nz, reach } = frames[i];
    const p = pts[i];
    for (let k = 0; k < across; k++) {
      const o = offsets[k];
      const side = o < 0 ? 0 : 1;
      const oo = Math.sign(o) * Math.min(Math.abs(o), reach[side]);
      const x = p.x + nx * oo;
      const z = p.z + nz * oo;
      const y = heightAt(x, z) + 0.02;
      const v = (i * across + k) * 3;
      verts[v] = x;
      verts[v + 1] = y;
      verts[v + 2] = z;
      uvs[(i * across + k) * 2] = x / 18;
      uvs[(i * across + k) * 2 + 1] = z / 18;
      const rgb = photo?.(x, z);
      if (rgb) tmp.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      else groundColor(tmp, x, y, z, g ? gridSlope(g, x, z) : 0);
      colors.set([tmp.r, tmp.g, tmp.b], v);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < across - 1; k++) {
      const a = i * across + k;
      const b = (i + 1) * across + k;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail ? null : map, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  if (photo) mat.color.setScalar(PHOTO_REFLECTANCE);
  if (detail) withDetail(mat, detail);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData.kind = "corridor";
  mesh.renderOrder = LAYER_ORDER.corridor;
  return mesh;
}

export function imageTexture(image: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(image);
  // ImageBitmaps upload as they are (flipY is ignored), so row 0 of the image is v = 0.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Anisotropic filtering is the single biggest per-pixel cost on an integrated GPU: 2 taps are enough for ground seen from a bike.
  tex.anisotropy = 2;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface Detail {
  grain: THREE.Texture;
  rock: THREE.Texture;
  scrub: THREE.Texture;
  normal: THREE.Texture;
  /** Metres one repeat of each detail texture covers. */
  rockScale: number;
  scrubScale: number;
  /** Mean colour of each, so it can be normalised to a neutral modulation. */
  rockMean: [number, number, number];
  scrubMean: [number, number, number];
}

/** A photo patch as a seamless detail texture: mirrored repeats hide the seams. */
export function patchTexture(image: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(image);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Anisotropic filtering is the single biggest per-pixel cost on an integrated GPU: 2 taps are enough for ground seen from a bike.
  tex.anisotropy = 2;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Surface detail over the aerial photo, which blurs into mush up close:
 * tiling limestone on steep faces (sampled triplanar so cliffs do not
 * stretch), scrub and earth on flatter ground, and a fine grain. The detail
 * textures average mid-grey, so the photo keeps its colour.
 */
export function withDetail(mat: THREE.MeshStandardMaterial, detail: Detail, amount = 1) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.rockMap = { value: detail.rock };
    shader.uniforms.scrubMap = { value: detail.scrub };
    shader.uniforms.detailAmount = { value: amount };
    shader.uniforms.rockScale = { value: detail.rockScale };
    shader.uniforms.scrubScale = { value: detail.scrubScale };
    shader.uniforms.rockMean = { value: new THREE.Vector3(...detail.rockMean) };
    shader.uniforms.scrubMean = { value: new THREE.Vector3(...detail.scrubMean) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGroundNormal = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D rockMap;\nuniform sampler2D scrubMap;\nuniform float detailAmount;\nuniform float rockScale;\nuniform float scrubScale;\nuniform vec3 rockMean;\nuniform vec3 scrubMean;\nvarying vec3 vGroundPos;\nvarying vec3 vGroundNormal;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
{
  // The photo carries its own shadows and glare: lift the shadows so our sun
  // does not darken them twice, take their blue cast out, and tame the glare
  // on bare limestone so it does not read as snow. A touch of warmth overall.
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  vec3 lifted = pow(diffuseColor.rgb, vec3(0.6));
  diffuseColor.rgb = mix(diffuseColor.rgb, lifted, 0.85 * (1.0 - smoothstep(0.15, 0.45, lum)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(1.04, 1.0, 0.92), 0.3 * (1.0 - smoothstep(0.1, 0.4, lum)));
  diffuseColor.rgb *= 1.0 - 0.42 * smoothstep(0.4, 0.8, lum);
  // A floor under the deepest photo shadows, so surface detail has something to modulate.
  diffuseColor.rgb += vec3(0.09, 0.085, 0.075) * (1.0 - smoothstep(0.0, 0.3, lum));
  diffuseColor.rgb *= vec3(1.03, 1.0, 0.94);
  vec3 n = normalize(vGroundNormal);
  // Detail sampled on the ground plane and on the dominant vertical plane, so cliffs do not stretch.
  vec2 vertical = abs(n.x) > abs(n.z) ? vGroundPos.zy : vGroundPos.xy;
  float wy = clamp(abs(n.y) * 1.4, 0.0, 1.0);
  vec3 rock = mix(texture2D(rockMap, vertical / rockScale).rgb, texture2D(rockMap, vGroundPos.xz / rockScale).rgb, wy) * (0.5 / max(rockMean, vec3(0.05)));
  // Scrub only on the ground plane: steep faces show rock anyway, and it saves a texture fetch per pixel.
  vec3 scrub = texture2D(scrubMap, vGroundPos.xz / scrubScale).rgb * (0.5 / max(scrubMean, vec3(0.05)));
  float steep = smoothstep(0.18, 0.5, 1.0 - n.y);
  vec3 det = mix(scrub, rock, steep);
  diffuseColor.rgb = diffuseColor.rgb * mix(vec3(1.0), det * 2.0, detailAmount * mix(0.5, 0.8, steep));
  // A photo taken from above says little about a cliff face: there, show the rock itself.
  vec3 rockFace = rock * rockMean * 2.0 * vec3(0.9, 0.88, 0.84);
  diffuseColor.rgb = mix(diffuseColor.rgb, rockFace * 0.8, detailAmount * steep * 0.75);
}`,
      );
  };
}

/** A rectangular block of a heightmap grid with one photo stretched over it. */
/** Half the inner width of a tunnel tube. */
export const TUNNEL_HALF = REAL_ROAD_WIDTH / 2 + 1.2;

export function gridBlockMesh(
  g: Grid,
  heightAt: (x: number, z: number) => number,
  rows: [number, number],
  cols: [number, number],
  map: THREE.Texture,
  detail: Detail | null,
  detailAmount = 1,
  /** Vertices to leave out: every triangle touching one is dropped (the ground over a tunnel tube). */
  skip?: (x: number, z: number) => boolean,
  /** The row and column range the photo spans, when this block is only part of it. */
  uvRows: [number, number] = rows,
  uvCols: [number, number] = cols,
): THREE.Mesh {
  const [r0, r1] = rows;
  const [c0, c1] = cols;
  const sz = g.spacingZ ?? g.spacing;
  const geo = new THREE.PlaneGeometry((c1 - c0) * g.spacing, (r1 - r0) * sz, c1 - c0, r1 - r0);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const skipped = skip ? new Uint8Array(pos.count) : null;
  let i = 0;
  for (let iz = r0; iz <= r1; iz++) {
    for (let ix = c0; ix <= c1; ix++) {
      const x = g.x0 + ix * g.spacing;
      const z = g.z0 + iz * sz;
      pos.setXYZ(i, x, heightAt(x, z), z);
      // Image row 0 is the north edge, which is the first grid row.
      uv.setXY(i, (ix - uvCols[0]) / (uvCols[1] - uvCols[0]), (iz - uvRows[0]) / (uvRows[1] - uvRows[0]));
      if (skipped && skip!(x, z)) skipped[i] = 1;
      i++;
    }
  }
  if (skipped?.some((v) => v)) {
    const old = geo.index!.array;
    const kept: number[] = [];
    for (let k = 0; k < old.length; k += 3) {
      if (!skipped[old[k]] && !skipped[old[k + 1]] && !skipped[old[k + 2]]) kept.push(old[k], old[k + 1], old[k + 2]);
    }
    geo.setIndex(kept);
  }
  geo.computeVertexNormals();
  // The photo already carries the sun's shading; lit again it blows out, so reflect less.
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0, color: new THREE.Color().setScalar(PHOTO_REFLECTANCE) });
  // No bump map: its tangents come from the photo's uv, which stretches into streaks on steep faces.
  if (detail) withDetail(mat, detail, detailAmount);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** One terrain mesh per heightmap grid, coloured by height and slope. */
export function gridMesh(g: Grid, heightAt: (x: number, z: number) => number, map: THREE.Texture, uvScale: number): THREE.Mesh {
  const w = (g.cols - 1) * g.spacing;
  const h = (g.rows - 1) * g.spacing;
  const geo = new THREE.PlaneGeometry(w, h, g.cols - 1, g.rows - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let iz = 0; iz < g.rows; iz++) {
    for (let ix = 0; ix < g.cols; ix++) {
      const i = iz * g.cols + ix;
      const x = g.x0 + ix * g.spacing;
      const z = g.z0 + iz * g.spacing;
      const y = heightAt(x, z);
      pos.setXYZ(i, x, y, z);
      uv.setXY(i, x / uvScale, z / uvScale);
      groundColor(tmp, x, y, z, gridSlope(g, x, z));
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 1, metalness: 0 }));
  mesh.receiveShadow = true;
  return mesh;
}

export function seaMesh(size: number, cx: number, cz: number): { mesh: THREE.Mesh; animate: (dt: number) => void } {
  const normals = waterNormalTexture();
  normals.repeat.set(size / 28, size / 28);
  const mat = new THREE.MeshStandardMaterial({
    color: "#2878a8",
    roughness: 0.45,
    metalness: 0.0,
    normalMap: normals,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.3,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.userData.kind = "sea";
  // After all the land: only the pixels where no land is in front get shaded.
  mesh.renderOrder = 1;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, SEA_LEVEL, cz);
  return {
    mesh,
    animate: (dt) => {
      normals.offset.x += dt * 0.004;
      normals.offset.y += dt * 0.0025;
    },
  };
}

/** Road width and markings by network class (0 primary .. 3 unclassified): main roads get edge lines and a dashed centre, lanes get nothing. */
export const ROAD_CLASS: { width: number; lines: "centre" | "edge" | "none" }[] = [
  { width: 6.6, lines: "centre" },
  { width: 6.0, lines: "centre" },
  { width: 5.6, lines: "edge" },
  { width: 4.6, lines: "none" },
];

/**
 * Draw order of the layers that lie on top of each other a few centimetres apart (opaque
 * objects otherwise go front to back): the top layer first, so the layers underneath fail
 * the depth test instead of being shaded and then painted over. The corridor strip covered
 * the ground grid and cost up to 6.7 ms of a 25 ms frame on Sa Calobra drawn the other way.
 */
export const LAYER_ORDER: Record<string, number> = { centre: -5, edge: -5, asphalt: -4, shoulder: -3, corridor: -2 };

export function roadMeshes(pts: Route["points"], closed: boolean, width = ROAD_WIDTH, mountain = false, asphalt = asphaltTexture(), lines: "centre" | "edge" | "none" | "test" = mountain ? "edge" : "test"): THREE.Mesh[] {
  const tag = (m: THREE.Mesh, kind: string) => {
    m.userData.kind = kind;
    m.renderOrder = LAYER_ORDER[kind] ?? 0;
    return m;
  };
  const meshes = [
    // Shoulder: a wide sandy verge on the test course, a narrow gravel edge on a mountain road.
    tag(ribbon(pts, closed, width + (mountain ? 1.0 : 2.2), 0.02, mountain ? "#7d7566" : "#b3a483"), "shoulder"),
    // Multiplied with the speckle texture (mean ~0.47), this lands near real asphalt's
    // 8–12 % reflectance; the old #454341 came to ~1 %, a black road in the sun.
    tag(ribbon(pts, closed, width, 0.05, mountain ? "#9a9894" : "#a2a5ab", { map: asphalt }), "asphalt"),
  ];
  if (lines !== "none") meshes.push(tag(ribbon(pts, closed, width - 0.4, 0.07, "#dcd9cf", { lineWidth: mountain ? 0.1 : 0.16, offset: (width - 0.4) / 2 }), "edge"));
  if (lines === "test") meshes.push(tag(ribbon(pts, closed, 0.16, 0.08, "#f2d75c", { dashed: true }), "centre"));
  if (lines === "centre") meshes.push(tag(ribbon(pts, closed, 0.12, 0.08, "#dcd9cf", { dashed: true }), "centre"));
  return meshes;
}

/**
 * Merges meshes that share a `userData.kind` into one mesh each (the first
 * one's material), so a tile's dozens of road pieces cost a handful of draw
 * calls. The originals' geometries are disposed.
 */
export function mergeByKind(meshes: THREE.Mesh[]): THREE.Mesh[] {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const m of meshes) {
    const kind = String(m.userData.kind ?? "");
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(m);
  }
  const out: THREE.Mesh[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      out.push(list[0]);
      continue;
    }
    const merged = mergeGeometries(
      list.map((m) => m.geometry),
      false,
    );
    for (const m of list) {
      m.geometry.dispose();
      if (m !== list[0]) (m.material as THREE.Material).dispose();
    }
    if (!merged) {
      out.push(...list);
      continue;
    }
    const mesh = new THREE.Mesh(merged, list[0].material);
    mesh.renderOrder = list[0].renderOrder;
    mesh.castShadow = list[0].castShadow;
    mesh.receiveShadow = list[0].receiveShadow;
    mesh.userData.kind = list[0].userData.kind;
    out.push(mesh);
  }
  return out;
}

/**
 * Low stone parapets along the road wherever the ground falls away beside it,
 * the way mountain roads are built. One box strip per continuous stretch.
 */
/**
 * A tunnel: a concrete tube around the road, a few metres past each portal,
 * with a headwall at both ends to hide where the hillside meets the road.
 */
let glow: THREE.Texture | null = null;
/** A soft round spot, white in the middle and clear at the edge: light pools under the tunnel lamps. */
function glowTexture(): THREE.Texture {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.5, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  glow.colorSpace = THREE.SRGBColorSpace;
  glow.userData.shared = true;
  return glow;
}

/**
 * `portals` says which ends of `pts` are real portals (headwall, daylight reaching in);
 * an end where a tile boundary or another tunnel edge cuts the run continues underground.
 */
export function tunnelMesh(pts: Route["points"], stone: THREE.Texture, portals: [boolean, boolean] = [true, true]): THREE.Group {
  const n = pts.length;
  const group = new THREE.Group();
  if (n < 2) return group;
  const half = TUNNEL_HALF;
  const wallH = 4.4;
  const archH = 1.4;
  // Extend the run past both ends along its direction.
  const ext = (a: Route["points"][number], b: Route["points"][number], m: number) => {
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { distance_m: a.distance_m - m, x: a.x + ((a.x - b.x) / l) * m, y: a.y + ((a.y - b.y) / l) * m, z: a.z + ((a.z - b.z) / l) * m };
  };
  const run = [ext(pts[0], pts[1], 4), ...pts, ext(pts[n - 1], pts[n - 2], 4)];
  // Cross-section, a closed loop from under the road's middle round the walls
  // and roof and back: the floor keeps the sea and the sunk far layer from
  // showing beside the road.
  const profile: [number, number][] = [
    [0, -0.15],
    [-half, -0.15],
    [-half, wallH],
    [-half * 0.7, wallH + archH * 0.7],
    [0, wallH + archH],
    [half * 0.7, wallH + archH * 0.7],
    [half, wallH],
    [half, -0.15],
    [0, -0.15],
  ];
  const across = profile.length;
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < run.length; i++) {
    const a = run[Math.max(i - 1, 0)];
    const b = run[Math.min(i + 1, run.length - 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    const p = run[i];
    profile.forEach(([o, h], k) => {
      verts.push(p.x + nx * o, p.y + h, p.z + nz * o);
      uvs.push(p.distance_m / 4, k / (across - 1));
    });
  }
  for (let i = 0; i < run.length - 1; i++) {
    for (let k = 0; k < across - 1; k++) {
      const a = i * across + k;
      const b = (i + 1) * across + k;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Lamps along the roof every 25 m (distances from the start of the run).
  const length = run[run.length - 1].distance_m - run[0].distance_m;
  const lampAt: number[] = [];
  for (let d = 12; d < length - 8; d += 25) lampAt.push(d);
  // The lamps' light is baked into the tube's vertex colours instead of real point
  // lights: every point light in the scene adds a loop to the shading of every lit pixel,
  // and a tunnel tile streaming in or out changed the light count, which recompiles every
  // shader in the scene (a visible stall). Unlit, the tube also keeps the sun out.
  const colors = new Float32Array(verts.length);
  for (let i = 0; i < run.length; i++) {
    const d = run[i].distance_m - run[0].distance_m;
    let lamp = 0;
    for (const a of lampAt) lamp += Math.exp(-(((d - a) / 8) ** 2));
    // Daylight reaches a few metres in from each portal.
    const day = Math.max(portals[0] ? smoothstep(14, 0, d) : 0, portals[1] ? smoothstep(length - 14, length, d) : 0);
    profile.forEach(([, h], k) => {
      const up = smoothstep(0, wallH + archH, h);
      const lit = 0.16 + Math.min(1, lamp) * (0.35 + 0.5 * up);
      const v = (i * across + k) * 3;
      colors[v] = lerp(lit, 0.85, day);
      colors[v + 1] = lerp(lit * 0.9, 0.85, day);
      colors[v + 2] = lerp(lit * 0.72, 0.85, day);
    });
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const rock = stone.clone();
  rock.needsUpdate = true;
  const tube = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#9a948a", map: rock, vertexColors: true, side: THREE.DoubleSide, fog: false }));
  group.add(tube);
  // The lamps as one mesh, and a pool of light on the road under each as one more.
  const lamps: THREE.BufferGeometry[] = [];
  const pools: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  for (const d of lampAt) {
    let i = 0;
    while (i < run.length - 2 && run[i + 1].distance_m - run[0].distance_m < d) i++;
    const p = run[i];
    const q = run[i + 1];
    const yaw = Math.atan2(q.x - p.x, q.z - p.z);
    m4.makeRotationY(yaw).setPosition(p.x, p.y + wallH + archH - 0.3, p.z);
    lamps.push(new THREE.BoxGeometry(0.5, 0.15, 1.2).applyMatrix4(m4));
    const pool = new THREE.PlaneGeometry(half * 2 - 0.6, 9).rotateX(-Math.PI / 2);
    m4.makeRotationY(yaw).setPosition(p.x, p.y + 0.1, p.z);
    pools.push(pool.applyMatrix4(m4));
  }
  if (lamps.length) {
    group.add(new THREE.Mesh(mergeGeometries(lamps, false)!, new THREE.MeshBasicMaterial({ color: "#fff2c8" })));
    const poolMesh = new THREE.Mesh(
      mergeGeometries(pools, false)!,
      new THREE.MeshBasicMaterial({ map: glowTexture(), color: "#ffcf80", transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    poolMesh.renderOrder = 2;
    group.add(poolMesh);
  }
  // Headwalls: a wide slab of stone around each portal mouth, all in one mesh.
  const walls: THREE.BufferGeometry[] = [];
  const ends: [Route["points"][number], Route["points"][number]][] = [];
  if (portals[0]) ends.push([run[0], run[1]]);
  if (portals[1]) ends.push([run[run.length - 1], run[run.length - 2]]);
  for (const [p, q] of ends) {
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = -(q.z - p.z) / l;
    const nz = (q.x - p.x) / l;
    const dx = (q.x - p.x) / l;
    const dz = (q.z - p.z) / l;
    // Two piers and a lintel around the opening, rooted 1.5 m into the ground. They run
    // deep (the tube's run past the portal plus some) so the tube is boxed in stone where
    // the hillside is cut open around the portal, instead of showing its bare outside.
    const pier = 4.5;
    const top = wallH + archH;
    const lintel = 3.0;
    const depth = 6.5;
    const yaw = Math.atan2(nx, nz) + Math.PI / 2;
    const place = (w: number, h: number, across: number, y: number) => {
      m4.makeRotationY(yaw).setPosition(p.x + dx * (depth / 2 - 0.7) + nx * across, y, p.z + dz * (depth / 2 - 0.7) + nz * across);
      walls.push(new THREE.BoxGeometry(w, h, depth).applyMatrix4(m4));
    };
    place(pier, top + lintel + 1.5, -(half + pier / 2), p.y + (top + lintel + 1.5) / 2 - 1.5);
    place(pier, top + lintel + 1.5, half + pier / 2, p.y + (top + lintel + 1.5) / 2 - 1.5);
    place(half * 2, lintel, 0, p.y + top + lintel / 2);
  }
  if (walls.length) {
    const wallMesh = new THREE.Mesh(mergeGeometries(walls, false)!, new THREE.MeshStandardMaterial({ color: "#8d8577", map: stone, roughness: 1 }));
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    group.add(wallMesh);
  }
  return group;
}

export function parapets(pts: Route["points"], heightAt: (x: number, z: number) => number, width: number, stone: THREE.Texture): THREE.Mesh {
  const n = pts.length;
  const offset = width / 2 + 0.75;
  const wallW = 0.4;
  const wallH = 0.7;
  const verts: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const pushQuad = (a: number[], b: number[], c: number[], d: number[], u0: number, u1: number, v1 = 1) => {
    const base = verts.length / 3;
    verts.push(...a, ...b, ...c, ...d);
    uvs.push(u0, 0, u1, 0, u0, v1, u1, v1);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
  // The outer face goes on down to the ground as a retaining wall, so a parapet
  // over a drop (or over the road below, where the road bridges itself) does not float.
  const SKIRT_MAX = 12;
  const footing = (v: number[]) => Math.max(Math.min(v[1], heightAt(v[0], v[2]) - 0.3), v[1] - SKIRT_MAX);
  for (const side of [-1, 1]) {
    // Does the ground drop more than 1.5 m within 6 m beyond the shoulder here?
    const drop = pts.map((p, i) => {
      const a = pts[Math.max(i - 1, 0)];
      const b = pts[Math.min(i + 1, n - 1)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / l) * side;
      const nz = ((b.x - a.x) / l) * side;
      const ground = Math.min(heightAt(p.x + nx * 4, p.z + nz * 4), heightAt(p.x + nx * 7, p.z + nz * 7));
      return { nx, nz, wall: ground < p.y - 1.5 };
    });
    // Close short gaps and drop very short stretches so walls read as built, not flickering.
    for (let i = 1; i < n - 1; i++) if (!drop[i].wall && drop[i - 1].wall && drop[i + 1].wall) drop[i].wall = true;
    for (let i = 0; i < n; i++) {
      if (!drop[i].wall) continue;
      let j = i;
      while (j < n && drop[j].wall) j++;
      if (j - i < 4) for (let k = i; k < j; k++) drop[k].wall = false;
      i = j;
    }
    for (let i = 0; i < n - 1; i++) {
      if (!drop[i].wall || !drop[i + 1].wall) continue;
      const p = pts[i];
      const q = pts[i + 1];
      const f = drop[i];
      const g = drop[i + 1];
      const inner0 = [p.x + f.nx * offset, p.y + 0.08, p.z + f.nz * offset];
      const inner1 = [q.x + g.nx * offset, q.y + 0.08, q.z + g.nz * offset];
      const outer0 = [p.x + f.nx * (offset + wallW), p.y + 0.08, p.z + f.nz * (offset + wallW)];
      const outer1 = [q.x + g.nx * (offset + wallW), q.y + 0.08, q.z + g.nz * (offset + wallW)];
      // Inside a tight bend the offset points converge or cross: that piece of wall
      // would fold flat across the hairpin, so it is left out.
      const along = (outer1[0] - outer0[0]) * (q.x - p.x) + (outer1[2] - outer0[2]) * (q.z - p.z);
      if (along < 0.3 * ((q.x - p.x) ** 2 + (q.z - p.z) ** 2)) continue;
      const up = (v: number[]) => [v[0], v[1] + wallH, v[2]];
      const u0 = p.distance_m / 2;
      const u1 = q.distance_m / 2;
      const foot0 = [outer0[0], footing(outer0), outer0[2]];
      const foot1 = [outer1[0], footing(outer1), outer1[2]];
      const tall = (Math.max(outer0[1] - foot0[1], outer1[1] - foot1[1]) + wallH) / wallH;
      pushQuad(inner0, inner1, up(inner0), up(inner1), u0, u1); // inner face
      pushQuad(foot1, foot0, up(outer1), up(outer0), u0, u1, tall); // outer face, down to the ground
      pushQuad(up(inner0), up(inner1), up(outer0), up(outer1), u0, u1); // top
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: "#b8ad98", map: stone, roughness: 1, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.kind = "parapet";
  return mesh;
}

export function cloudLayers(cx: number, cz: number): { meshes: THREE.Mesh[]; animate: (dt: number) => void } {
  const meshes: THREE.Mesh[] = [];
  const speeds: number[] = [];
  for (const [alt, coverage, seed, rep, speed] of [
    [700, 0.28, 61, 6, 0.0012],
    [1600, 0.18, 62, 3, 0.0005],
  ] as const) {
    const tex = cloudTexture(coverage, seed);
    tex.repeat.set(rep, rep);
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.85 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(FAR_SIZE * 2, FAR_SIZE * 2), mat);
    m.rotation.x = Math.PI / 2;
    m.position.set(cx, alt, cz);
    m.renderOrder = 1;
    meshes.push(m);
    speeds.push(speed);
  }
  return {
    meshes,
    animate: (dt) => meshes.forEach((m, i) => ((m.material as THREE.MeshLambertMaterial).map!.offset.x += dt * speeds[i])),
  };
}

function buildProceduralWorld(route: Route): WorldStatics {
  const sampler = new RouteSampler(route);
  const pts = route.points;
  const index = new RouteIndex(pts);
  const group = new THREE.Group();

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  const lake = { x: cx, z: cz, y: sampler.minY - 6 };
  // The coast runs north-south west of the loop, wandering a little.
  const coastX = (z: number) => cx - 1150 + (fbm(0, z, 900, 77) - 0.5) * 500;

  /** Rolling land before the road, lake and sea are cut in. */
  const land = (x: number, z: number) => (fbm(x, z, 520, 3) - 0.35) * 110 + (fbm(x, z, 90, 11) - 0.5) * 8;

  const heightAt = (x: number, z: number): number => {
    const hills = land(x, z);
    const near = index.nearest(x, z, 240);
    const road = near.d < 240 ? near.y - 0.35 : hills;
    let h = lerp(road, hills, smoothstep(9, 150, near.d));
    const toLake = Math.hypot(x - lake.x, z - lake.z);
    h = lerp(lake.y - 4, h, smoothstep(LAKE_RADIUS - 20, LAKE_RADIUS + 90, toLake));
    // Down to the beach and under the sea on the west.
    const shore = smoothstep(coastX(z) - 60, coastX(z) + 260, x);
    const seabed = SEA_LEVEL - 10 + (fbm(x, z, 200, 5) - 0.5) * 4;
    return lerp(seabed, h, shore);
  };

  /** Mountains for the far plane: the near land continues, then rises with distance. */
  const farHeightAt = (x: number, z: number): number => {
    const d = Math.hypot(x - cx, z - cz);
    const nearPart = heightAt(x, z) - 2;
    const ridges = 1 - Math.abs(fbm(x, z, 1500, 8) * 2 - 1);
    const mountains = ridges * ridges * 1100 * smoothstep(2200, 5200, d) + (fbm(x, z, 420, 9) - 0.5) * 160 * smoothstep(1800, 3200, d);
    let h = lerp(nearPart, land(x, z) + mountains, smoothstep(1500, 2400, d));
    // No mountains out at sea: the coast continues as low land, then open water.
    const shore = smoothstep(coastX(z) - 300, coastX(z) + 400, x);
    const sea = SEA_LEVEL - 12;
    return lerp(sea, h, shore * (1 - 0.0 * d));
  };

  const grass = grassTexture();
  const rockTex = rockTexture();

  // Near terrain.
  {
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grassLow = new THREE.Color("#7fb55a");
    const grassHigh = new THREE.Color("#a8c96e");
    const dry = new THREE.Color("#b9a86a");
    const sand = new THREE.Color("#d9c99a");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const h = heightAt(x, z);
      pos.setXYZ(i, x, h, z);
      uv.setXY(i, x / 18, z / 18);
      const t = smoothstep(sampler.minY, sampler.maxY + 60, h);
      tmp.copy(grassLow).lerp(grassHigh, t);
      tmp.lerp(dry, 0.5 * fbm(x, z, 260, 15));
      if (h < SEA_LEVEL + 4) tmp.lerp(sand, smoothstep(SEA_LEVEL + 4, SEA_LEVEL - 2, h));
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: grass, roughness: 1, metalness: 0 }));
    terrain.receiveShadow = true;
    group.add(terrain);
  }

  // Far terrain: mountains all round, hidden under the near terrain in the middle.
  {
    const geo = new THREE.PlaneGeometry(FAR_SIZE, FAR_SIZE, FAR_SEGMENTS, FAR_SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const low = new THREE.Color("#7fae5d");
    const scrub = new THREE.Color("#8a9a5a");
    const rock = new THREE.Color("#9a9288");
    const top = new THREE.Color("#c9c3ba");
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx;
      const z = pos.getZ(i) + cz;
      const h = farHeightAt(x, z);
      pos.setXYZ(i, x, h, z);
      uv.setXY(i, x / 520, z / 520);
      tmp.copy(low).lerp(scrub, smoothstep(80, 300, h)).lerp(rock, smoothstep(300, 650, h)).lerp(top, smoothstep(650, 1000, h));
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const far = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: rockTex, roughness: 1 }));
    group.add(far);
  }

  // Sea and lake.
  const sea = seaMesh(FAR_SIZE, cx, cz);
  group.add(sea.mesh);
  const lakeNormals = waterNormalTexture();
  lakeNormals.repeat.set(12, 12);
  const lakeMat = new THREE.MeshStandardMaterial({
    color: "#2b7fb8",
    roughness: 0.15,
    normalMap: lakeNormals,
    normalScale: new THREE.Vector2(0.25, 0.25),
    transparent: true,
    opacity: 0.94,
  });
  const water = new THREE.Mesh(new THREE.CircleGeometry(LAKE_RADIUS + 30, 64), lakeMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(lake.x, lake.y, lake.z);
  group.add(water);

  group.add(...roadMeshes(pts, route.closed));
  const clouds = cloudLayers(cx, cz);
  group.add(...clouds.meshes);

  const landInfo: Land = {
    height: heightAt,
    water: (x, z) => Math.hypot(x - lake.x, z - lake.z) < LAKE_RADIUS + 50 || x < coastX(z) + 120,
    slope: () => 0,
  };
  const region = { x0: cx - TERRAIN_SIZE * 0.45, z0: cz - TERRAIN_SIZE * 0.45, w: TERRAIN_SIZE * 0.9, h: TERRAIN_SIZE * 0.9 };
  group.add(vegetation(index, heightAt, landInfo, region, sampler, false, null));

  const animate = (dt: number) => {
    sea.animate(dt);
    lakeNormals.offset.x += dt * 0.01;
    clouds.animate(dt);
  };

  return { group, heightAt, animate };
}

/** Pines, round trees, cypresses, bushes (card models from the foliage atlas) and rocks, instanced per kind. */
export function vegetation(
  index: RoadIndex,
  heightAt: (x: number, z: number) => number,
  land: Land,
  region: { x0: number; z0: number; w: number; h: number },
  sampler: RouteSampler,
  mediterranean: boolean,
  photo: ((x: number, z: number) => [number, number, number] | null) | null,
  scale = 1,
): THREE.Group {
  const g = new THREE.Group();
  /** How much the aerial photo says "trees" here: dark green pixels. 0..1. */
  const treeCover = (x: number, z: number): number => {
    const c = photo?.(x, z);
    if (!c) return 0.3;
    const [r, gr, b] = c;
    const green = gr - Math.max(r, b);
    const dark = 1 - smoothstep(0.3, 0.55, (r + gr + b) / 3);
    return smoothstep(0.0, 0.08, green) * (0.4 + 0.6 * dark);
  };
  const rand = mulberry32(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();

  const rockMat = new THREE.MeshStandardMaterial({ color: "#8d8880", roughness: 1 });
  const foliage = foliageMaterial();
  const rock = new THREE.IcosahedronGeometry(1, 1);
  rock.scale(1.3, 0.8, 1);

  // Trees are card models from the foliage atlas (see trees.ts); the palette
  // tints the texture, so it stays close to white.
  const kinds = mediterranean
    ? {
        pine: { geos: [treeGeometry("pine")], count: 3000, palette: ["#e2e8dc", "#d4dccc", "#eaeee2", "#c8d4be", "#dce4d0"] },
        round: { geos: [treeGeometry("round")], count: 250, palette: ["#e4ead8", "#d6dec8", "#ecf0e0"] },
        cypress: { geos: [treeGeometry("cypress")], count: 60, palette: ["#e0e6dc", "#d2dccc", "#eaeee4"] },
      }
    : {
        pine: { geos: [treeGeometry("pine")], count: 1500, palette: ["#e6f0dc", "#f0f6e6", "#d8e8d0", "#ecf4e0"] },
        round: { geos: [treeGeometry("round")], count: 900, palette: ["#e8f0d8", "#f0f4e0", "#dce8cc", "#f2f6e4"] },
        cypress: { geos: [treeGeometry("cypress")], count: 350, palette: ["#e0e6dc", "#d2dccc", "#eaeee4"] },
      };
  const bushes = { geos: [treeGeometry("bush")], count: mediterranean ? 1500 : 1800, palette: mediterranean ? ["#dce0cc", "#e6e8d4", "#d0d6c0"] : ["#e6f0d4", "#eef4dc", "#dce8c8"] };
  const rocks = { count: mediterranean ? 1500 : 400 };

  const canPlace = (x: number, z: number, minRoad: number): { ok: boolean; near: number } => {
    if (land.water(x, z)) return { ok: false, near: 0 };
    const near = index.nearest(x, z, 240).d;
    if (near < ROAD_WIDTH / 2 + minRoad) return { ok: false, near };
    return { ok: true, near };
  };
  const spot = () => [region.x0 + rand() * region.w, region.z0 + rand() * region.h] as const;
  // Real terrain: nothing on cliffs, thinning out with altitude.
  const terrainOk = (x: number, z: number, y: number, maxSlope: number) =>
    !mediterranean || (land.slope(x, z) < maxSlope && rand() > smoothstep(450, 950, y));

  const place = (geos: THREE.BufferGeometry[], count0: number, palette: string[], density: (near: number, x: number, z: number) => number, sizeRange: [number, number], minRoad: number, mat: THREE.Material = foliage, shadows = true) => {
    const count = Math.max(1, Math.round(count0 * scale));
    const meshes = geos.map((geo) => {
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      if (mat === foliage) mesh.customDepthMaterial = foliageDepthMaterial();
      return mesh;
    });
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 25; tries++) {
      const [x, z] = spot();
      const { ok, near } = canPlace(x, z, minRoad);
      if (!ok || rand() > density(near, x, z)) continue;
      const y = heightAt(x, z);
      if (y < SEA_LEVEL + 3) continue;
      if (!mediterranean && y > sampler.maxY + 45) continue;
      if (!terrainOk(x, z, y, geos === kinds.pine.geos ? 0.7 : 0.55)) continue;
      const s = sizeRange[0] + rand() * (sizeRange[1] - sizeRange[0]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, y - 0.1, z), q, new THREE.Vector3(s, s * (0.85 + rand() * 0.35), s));
      for (const mesh of meshes) {
        mesh.setMatrixAt(placed, m);
        mesh.setColorAt(placed, col.set(palette[Math.floor(rand() * palette.length)]).offsetHSL(0, 0, (rand() - 0.5) * 0.08));
      }
      placed++;
    }
    for (const mesh of meshes) {
      mesh.count = placed;
      mesh.castShadow = shadows;
      g.add(mesh);
    }
  };

  const forest = (near: number, x: number, z: number) =>
    mediterranean ? (photo ? treeCover(x, z) : fbm(x, z, 350, 5) > 0.4 ? 0.9 : 0.15) : (0.2 + 0.8 * (1 - smoothstep(30, 500, near))) * (fbm(x, z, 300, 5) > 0.42 ? 1 : 0.1);
  place(kinds.pine.geos, kinds.pine.count, kinds.pine.palette, forest, mediterranean ? [0.55, 1.15] : [0.7, 1.4], mediterranean ? 3 : 5);
  place(kinds.round.geos, kinds.round.count, kinds.round.palette, (n, x, z) => forest(n, x, z) * (fbm(x, z, 500, 6) > 0.5 ? 1.2 : 0.3), [0.6, 1.1], 6);
  place(kinds.cypress.geos, kinds.cypress.count, kinds.cypress.palette, (n) => 0.9 * (1 - smoothstep(12, 120, n)), [0.55, 1.0], 3);
  place(bushes.geos, bushes.count, bushes.palette, (n, x, z) => (mediterranean ? 0.5 + 0.5 * treeCover(x, z) : 0.9) * (1 - smoothstep(5, 200, n)), [0.5, 1.3], 1.6, foliage, false);
  place([rock], rocks.count, ["#aaa49a", "#9c968c", "#b5afa5"], (n, x, z) => (mediterranean ? 0.4 + 0.6 * smoothstep(0.3, 0.8, land.slope(x, z)) : 0.8 * (1 - smoothstep(6, 160, n))), [0.25, mediterranean ? 0.8 : 1.0], 1.8, rockMat, false);
  return g;
}

interface RibbonMarks {
  dashed?: boolean;
  lineWidth?: number;
  offset?: number;
  map?: THREE.Texture;
}

/** A flat strip of `width` metres following the route points, `lift` above them. */
function ribbon(pts: Route["points"], closed: boolean, width: number, lift: number, color: string, marks: RibbonMarks = {}): THREE.Mesh {
  const n = pts.length;
  const verts: number[] = [];
  const uvs: number[] = [];
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
    const v = p.distance_m / width;
    if (edge) {
      for (const side of [-1, 1]) {
        const o = side * (marks.offset ?? half);
        const w = marks.lineWidth! / 2;
        verts.push(p.x + nx * (o - w), p.y + lift, p.z + nz * (o - w), p.x + nx * (o + w), p.y + lift, p.z + nz * (o + w));
        uvs.push(0, v, 1, v);
      }
    } else {
      verts.push(p.x + nx * half, p.y + lift, p.z + nz * half, p.x - nx * half, p.y + lift, p.z - nz * half);
      uvs.push(0, v, 1, v);
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
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color, map: marks.map ?? null, roughness: 0.95, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}
