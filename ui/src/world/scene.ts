// Static world geometry built once from the route: terrain, sea, lake, road,
// far mountains, clouds and vegetation. Everything is procedural.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Route } from "../types";
import { fbm, mulberry32 } from "./noise";
import { RouteSampler } from "./route";
import { gridSample, gridSlope, imageMean, OrthoSampler, type Grid, type WorldData } from "./terrain";
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
    for (let br = 0; br < rowEdges.length - 1; br++) {
      for (let bc = 0; bc < colEdges.length - 1; bc++) {
        const tex = imageTexture(images[br][bc]);
        group.add(gridBlockMesh(near, tucked, [rowEdges[br], rowEdges[br + 1]], [colEdges[bc], colEdges[bc + 1]], tex, detail));
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
  // each side before another part of the road is closer (hairpins).
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
        const other = q.edge !== undefined && edgeId >= 0 ? q.edge !== edgeId || Math.abs(q.i - (startIndex + i)) > 12 : Math.abs(q.i - i) > 12;
        if (q.i >= 0 && other && q.d < o * 0.95) {
          r = Math.max(SHOULDER, o - 0.5 * (o - q.d));
          break;
        }
      }
      return r;
    });
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
  return mesh;
}

export function imageTexture(image: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(image);
  // ImageBitmaps upload as they are (flipY is ignored), so row 0 of the image is v = 0.
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
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
  tex.anisotropy = 8;
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
  vec3 scrub = mix(texture2D(scrubMap, vertical / scrubScale).rgb, texture2D(scrubMap, vGroundPos.xz / scrubScale).rgb, wy) * (0.5 / max(scrubMean, vec3(0.05)));
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
      uv.setXY(i, (ix - c0) / (c1 - c0), (iz - r0) / (r1 - r0));
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

export function roadMeshes(pts: Route["points"], closed: boolean, width = ROAD_WIDTH, mountain = false, asphalt = asphaltTexture()): THREE.Mesh[] {
  const meshes = [
    // Shoulder: a wide sandy verge on the test course, a narrow gravel edge on a mountain road.
    ribbon(pts, closed, width + (mountain ? 1.0 : 2.2), 0.02, mountain ? "#7d7566" : "#b3a483"),
    ribbon(pts, closed, width, 0.05, mountain ? "#454341" : "#55585f", { map: asphalt }),
    ribbon(pts, closed, width - 0.4, 0.07, "#dcd9cf", { lineWidth: mountain ? 0.1 : 0.16, offset: (width - 0.4) / 2 }),
  ];
  if (!mountain) meshes.push(ribbon(pts, closed, 0.16, 0.08, "#f2d75c", { dashed: true }));
  return meshes;
}

/**
 * Low stone parapets along the road wherever the ground falls away beside it,
 * the way mountain roads are built. One box strip per continuous stretch.
 */
/**
 * A tunnel: a concrete tube around the road, a few metres past each portal,
 * with a headwall at both ends to hide where the hillside meets the road.
 */
export function tunnelMesh(pts: Route["points"], stone: THREE.Texture): THREE.Group {
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
  const run = [ext(pts[0], pts[1], 6), ...pts, ext(pts[n - 1], pts[n - 2], 6)];
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
  // Rough rock, lit only by the lamps: a dim self-light stands in for them, and fog is kept out.
  const rock = stone.clone();
  rock.needsUpdate = true;
  const tube = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#4a4742", map: rock, emissive: "#0f0e0b", roughness: 1, side: THREE.DoubleSide, fog: false }));
  tube.receiveShadow = true;
  group.add(tube);
  // Lamps along the roof every 25 m, with a little light on the road under each.
  const lampGeo = new THREE.BoxGeometry(0.5, 0.15, 1.2);
  const lampMat = new THREE.MeshBasicMaterial({ color: "#fff2c8" });
  for (let d = 12; d < run[run.length - 1].distance_m - run[0].distance_m - 8; d += 25) {
    let i = 0;
    while (i < run.length - 2 && run[i + 1].distance_m - run[0].distance_m < d) i++;
    const p = run[i];
    const q = run[i + 1];
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(p.x, p.y + wallH + archH - 0.3, p.z);
    lamp.rotation.y = Math.atan2(q.x - p.x, q.z - p.z);
    group.add(lamp);
    const light = new THREE.PointLight("#ffe9b0", 2.5, 22, 2);
    light.position.set(p.x, p.y + wallH + archH - 0.6, p.z);
    group.add(light);
  }
  // Headwalls: a wide slab of stone around each portal mouth.
  for (const [p, q] of [
    [run[0], run[1]],
    [run[run.length - 1], run[run.length - 2]],
  ]) {
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = -(q.z - p.z) / l;
    const nz = (q.x - p.x) / l;
    const dx = (q.x - p.x) / l;
    const dz = (q.z - p.z) / l;
    // Two piers and a lintel around the opening, 1.2 m thick, rooted 1.5 m into the ground.
    const pier = 4.5;
    const top = wallH + archH;
    const lintel = 3.0;
    const mat = new THREE.MeshStandardMaterial({ color: "#8d8577", map: stone, roughness: 1 });
    const yaw = Math.atan2(nx, nz) + Math.PI / 2;
    const place = (w: number, h: number, across: number, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.2), mat);
      m.position.set(p.x + dx * 0.6 + nx * across, y, p.z + dz * 0.6 + nz * across);
      m.rotation.y = yaw;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    };
    place(pier, top + lintel + 1.5, -(half + pier / 2), p.y + (top + lintel + 1.5) / 2 - 1.5);
    place(pier, top + lintel + 1.5, half + pier / 2, p.y + (top + lintel + 1.5) / 2 - 1.5);
    place(half * 2, lintel, 0, p.y + top + lintel / 2);
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
  const pushQuad = (a: number[], b: number[], c: number[], d: number[], u0: number, u1: number) => {
    const base = verts.length / 3;
    verts.push(...a, ...b, ...c, ...d);
    uvs.push(u0, 0, u1, 0, u0, 1, u1, 1);
    idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  };
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
      const up = (v: number[]) => [v[0], v[1] + wallH, v[2]];
      const u0 = p.distance_m / 2;
      const u1 = q.distance_m / 2;
      pushQuad(inner0, inner1, up(inner0), up(inner1), u0, u1); // inner face
      pushQuad(outer1, outer0, up(outer1), up(outer0), u0, u1); // outer face
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

/** Pines, round trees, cypresses, bushes and rocks, instanced per kind. */
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

  const trunkMat = new THREE.MeshStandardMaterial({ color: "#6b4a2b", roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9 });
  const rockMat = new THREE.MeshStandardMaterial({ color: "#8d8880", roughness: 1 });

  // Pine: trunk + two stacked cones (the test course), or an Aleppo pine with
  // a broad, uneven crown of flattened blobs (real terrain).
  const c1 = new THREE.ConeGeometry(2.6, 6, 7);
  c1.translate(0, 5, 0);
  const c2 = new THREE.ConeGeometry(1.8, 5, 7);
  c2.translate(0, 8.5, 0);
  const blob = (r: number, sy: number, x: number, y: number, z: number) => {
    const b = new THREE.SphereGeometry(r, 7, 5);
    b.scale(1, sy, 1);
    b.translate(x, y, z);
    return b;
  };
  const aleppo = mergeGeometries([blob(2.9, 0.55, 0, 6.4, 0), blob(2.2, 0.6, 1.6, 5.6, 0.9), blob(2.0, 0.6, -1.5, 5.9, -1.0), blob(1.7, 0.65, 0.3, 7.3, -0.4), blob(1.5, 0.6, -0.8, 4.9, 1.4)]);

  // Round tree: trunk + three spheres.
  const roundCrown = [new THREE.SphereGeometry(2.2, 9, 7), new THREE.SphereGeometry(1.7, 9, 7), new THREE.SphereGeometry(1.6, 9, 7)];
  roundCrown[0].translate(0, 4.6, 0);
  roundCrown[1].translate(1.4, 3.9, 0.7);
  roundCrown[2].translate(-1.2, 4.1, -0.8);
  // Cypress: tall narrow ellipsoid.
  const cypress = new THREE.SphereGeometry(1, 7, 8);
  cypress.scale(0.9, 4.2, 0.9);
  cypress.translate(0, 4.2, 0);
  const trunk = new THREE.CylinderGeometry(0.22, 0.38, 2.6, 6);
  trunk.translate(0, 1.3, 0);
  const bush = new THREE.SphereGeometry(1, 7, 5);
  bush.scale(1.4, 0.9, 1.4);
  bush.translate(0, 0.7, 0);
  const rock = new THREE.IcosahedronGeometry(1, 1);
  rock.scale(1.3, 0.8, 1);

  const kinds = mediterranean
    ? {
        pine: { geos: [aleppo], count: 3000, palette: ["#263f24", "#2d4a28", "#213822", "#345430", "#2a4327", "#3b5a33"] },
        round: { geos: roundCrown, count: 250, palette: ["#3d5a2e", "#46632f", "#35502a"] },
        cypress: { geos: [cypress], count: 60, palette: ["#24502a", "#2b5a30", "#1f4524"] },
      }
    : {
        pine: { geos: [c1, c2], count: 1500, palette: ["#2f7d3a", "#3c8f3f", "#2b6b45", "#4a8f3e"] },
        round: { geos: roundCrown, count: 900, palette: ["#3e8a3c", "#4f8f44", "#467a2f", "#5a9a44"] },
        cypress: { geos: [cypress], count: 350, palette: ["#24502a", "#2b5a30", "#1f4524"] },
      };
  const bushes = { count: mediterranean ? 1500 : 1800, palette: mediterranean ? ["#4e5f2a", "#596a33", "#465525"] : ["#5f8233", "#75903f", "#6a7f34"] };
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

  const place = (geos: THREE.BufferGeometry[], count0: number, palette: string[], withTrunk: boolean, density: (near: number, x: number, z: number) => number, sizeRange: [number, number], minRoad: number, mat = leafMat, shadows = true) => {
    const count = Math.max(1, Math.round(count0 * scale));
    const meshes = geos.map((geo) => new THREE.InstancedMesh(geo, mat, count));
    const trunks = withTrunk ? new THREE.InstancedMesh(trunk, trunkMat, count) : null;
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
      trunks?.setMatrixAt(placed, m);
      placed++;
    }
    for (const mesh of meshes) {
      mesh.count = placed;
      mesh.castShadow = shadows;
      g.add(mesh);
    }
    if (trunks) {
      trunks.count = placed;
      trunks.castShadow = true;
      g.add(trunks);
    }
  };

  const forest = (near: number, x: number, z: number) =>
    mediterranean ? (photo ? treeCover(x, z) : fbm(x, z, 350, 5) > 0.4 ? 0.9 : 0.15) : (0.2 + 0.8 * (1 - smoothstep(30, 500, near))) * (fbm(x, z, 300, 5) > 0.42 ? 1 : 0.1);
  place(kinds.pine.geos, kinds.pine.count, kinds.pine.palette, true, forest, mediterranean ? [0.55, 1.15] : [0.7, 1.4], mediterranean ? 3 : 5);
  place(kinds.round.geos, kinds.round.count, kinds.round.palette, true, (n, x, z) => forest(n, x, z) * (fbm(x, z, 500, 6) > 0.5 ? 1.2 : 0.3), [0.6, 1.1], 6);
  place(kinds.cypress.geos, kinds.cypress.count, kinds.cypress.palette, true, (n) => 0.9 * (1 - smoothstep(12, 120, n)), [0.55, 1.0], 3);
  place([bush], bushes.count, bushes.palette, false, (n, x, z) => (mediterranean ? 0.5 + 0.5 * treeCover(x, z) : 0.9) * (1 - smoothstep(5, 200, n)), [0.5, 1.3], 1.6, leafMat, false);
  place([rock], rocks.count, ["#aaa49a", "#9c968c", "#b5afa5"], false, (n, x, z) => (mediterranean ? 0.4 + 0.6 * smoothstep(0.3, 0.8, land.slope(x, z)) : 0.8 * (1 - smoothstep(6, 160, n))), [0.25, mediterranean ? 0.8 : 1.0], 1.8, rockMat, false);
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
