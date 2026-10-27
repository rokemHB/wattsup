// Static world geometry built once from the route: terrain, sea, lake, road,
// far mountains, clouds and vegetation. Everything is procedural.
import * as THREE from "three";
import type { Route } from "../types";
import { fbm, mulberry32 } from "./noise";
import { RouteSampler } from "./route";
import { gridSample, gridSlope, OrthoSampler, type Grid, type WorldData } from "./terrain";
import { asphaltTexture, cloudTexture, detailTexture, grassTexture, rockTexture, waterNormalTexture } from "./textures";

export const ROAD_WIDTH = 7;
/** Height of the top road layer (the markings) above the route line. */
export const ROAD_LIFT = 0.08;
const TERRAIN_SIZE = 3400;
const TERRAIN_SEGMENTS = 240;
const FAR_SIZE = 18000;
const FAR_SEGMENTS = 180;
const LAKE_RADIUS = 300;
const SEA_LEVEL = 0;

export interface WorldStatics {
  group: THREE.Group;
  /** Terrain height at a ground position. */
  heightAt: (x: number, z: number) => number;
  /** Advances water and clouds. */
  animate: (dt: number) => void;
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

const smoothstep = (a: number, b: number, t: number) => {
  const x = Math.min(Math.max((t - a) / (b - a), 0), 1);
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the land is in a procedural world versus a real one. */
interface Land {
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
  const { near, far } = world;

  const raw = (x: number, z: number) => gridSample(near, x, z) ?? gridSample(far, x, z) ?? SEA_LEVEL - 10;
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
    if (n.d > CORRIDOR_REACH) return h;
    const bed = n.y - 0.35;
    if (n.d <= SHOULDER) return bed;
    const out = n.d - SHOULDER;
    return Math.min(Math.max(h, bed - out * FILL_SLOPE), bed + out * CUT_SLOPE);
  };
  const heightAt = (x: number, z: number): number => corridor(x, z, raw(x, z));
  // Under the corridor strip the coarse grid is tucked away so its 10 m triangles cannot poke through.
  const tucked = (x: number, z: number): number => {
    const h = heightAt(x, z);
    if (x < box.x0 || x > box.x1 || z < box.z0 || z > box.z1) return h;
    const n = index.nearest(x, z, CORRIDOR_REACH);
    return h - 1.2 * (1 - smoothstep(CORRIDOR_REACH - 12, CORRIDOR_REACH, n.d));
  };
  const land: Land = {
    height: heightAt,
    water: (x, z) => raw(x, z) < SEA_LEVEL + 1.5,
    slope: (x, z) => gridSlope(near, x, z),
  };

  const grass = grassTexture();
  const rockTex = rockTexture();
  const detail = detailTexture();
  const inNear = (x: number, z: number) => gridSample(near, x, z) !== null;
  const farHeight = (x: number, z: number) => (inNear(x, z) ? raw(x, z) - 6 : raw(x, z));
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
    group.add(corridorMesh(pts, index, heightAt, near, detail, (x, z) => sampler.colorAt(x, z)));
    if (far.ortho) {
      group.add(gridBlockMesh(far, farHeight, [0, far.rows - 1], [0, far.cols - 1], imageTexture(far.ortho.images[0][0]), null));
    } else {
      group.add(gridMesh(far, farHeight, rockTex, 520));
    }
  } else {
    group.add(gridMesh(near, tucked, grass, 18));
    group.add(corridorMesh(pts, index, heightAt, near, grass, null));
    group.add(gridMesh(far, farHeight, rockTex, 520));
  }

  const sea = seaMesh(FAR_SIZE * 2, (near.x0 + (near.cols * near.spacing) / 2), (near.z0 + (near.rows * near.spacing) / 2));
  group.add(sea.mesh);
  group.add(...roadMeshes(pts, route.closed));
  const clouds = cloudLayers((near.x0 + (near.cols * near.spacing) / 2), (near.z0 + (near.rows * near.spacing) / 2));
  group.add(...clouds.meshes);
  const region = { x0: near.x0, z0: near.z0, w: near.cols * near.spacing, h: near.rows * near.spacing };
  group.add(vegetation(index, heightAt, land, region, sampler, true));

  const animate = (dt: number) => {
    sea.animate(dt);
    clouds.animate(dt);
  };
  return { group, heightAt, animate };
}

/** How much of the aerial photo's brightness the terrain reflects under the scene's own sun. */
const PHOTO_REFLECTANCE = 0.62;
const SHOULDER = ROAD_WIDTH / 2 + 1.3;
/** Metres either side of the road that the corridor shapes. */
const CORRIDOR_REACH = 46;
/** Rise over run of the cut bank above the road and the fill bank below it. */
const CUT_SLOPE = 1.2;
const FILL_SLOPE = 0.7;
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
function corridorMesh(
  pts: Route["points"],
  index: RouteIndex,
  heightAt: (x: number, z: number) => number,
  g: Grid,
  map: THREE.Texture,
  photo: ((x: number, z: number) => [number, number, number] | null) | null,
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
        if (q.i >= 0 && Math.abs(q.i - i) > 12 && q.d < o * 0.95) {
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
      else groundColor(tmp, x, y, z, gridSlope(g, x, z));
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
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map, roughness: 1, metalness: 0, side: THREE.DoubleSide });
  if (photo) mat.color.setScalar(PHOTO_REFLECTANCE * 1.28); // the grey grain averages below white
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function imageTexture(image: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Multiplies a world-space grain over the photo so it does not blur into mush up close. */
function withDetail(mat: THREE.MeshStandardMaterial, detail: THREE.Texture) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D detailMap;\nvarying vec3 vGroundPos;")
      .replace(
        "#include <map_fragment>",
        "#include <map_fragment>\n{ float d = texture2D(detailMap, vGroundPos.xz / 7.0).r; float d2 = texture2D(detailMap, vGroundPos.xz / 1.3).r; float d3 = texture2D(detailMap, vGroundPos.xz / 0.35).r; diffuseColor.rgb *= (0.6 + 0.5 * d) * (0.7 + 0.45 * d2) * (0.85 + 0.25 * d3); }",
      );
  };
}

/** A rectangular block of a heightmap grid with one photo stretched over it. */
function gridBlockMesh(
  g: Grid,
  heightAt: (x: number, z: number) => number,
  rows: [number, number],
  cols: [number, number],
  map: THREE.Texture,
  detail: THREE.Texture | null,
): THREE.Mesh {
  const [r0, r1] = rows;
  const [c0, c1] = cols;
  const geo = new THREE.PlaneGeometry((c1 - c0) * g.spacing, (r1 - r0) * g.spacing, c1 - c0, r1 - r0);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  let i = 0;
  for (let iz = r0; iz <= r1; iz++) {
    for (let ix = c0; ix <= c1; ix++) {
      const x = g.x0 + ix * g.spacing;
      const z = g.z0 + iz * g.spacing;
      pos.setXYZ(i, x, heightAt(x, z), z);
      uv.setXY(i, (ix - c0) / (c1 - c0), 1 - (iz - r0) / (r1 - r0));
      i++;
    }
  }
  geo.computeVertexNormals();
  // The photo already carries the sun's shading; lit again it blows out, so reflect less.
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0, color: new THREE.Color().setScalar(PHOTO_REFLECTANCE) });
  if (detail) withDetail(mat, detail);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** One terrain mesh per heightmap grid, coloured by height and slope. */
function gridMesh(g: Grid, heightAt: (x: number, z: number) => number, map: THREE.Texture, uvScale: number): THREE.Mesh {
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

function seaMesh(size: number, cx: number, cz: number): { mesh: THREE.Mesh; animate: (dt: number) => void } {
  const normals = waterNormalTexture();
  normals.repeat.set(size / 45, size / 45);
  const mat = new THREE.MeshStandardMaterial({
    color: "#1c6ea6",
    roughness: 0.18,
    metalness: 0.0,
    normalMap: normals,
    normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: true,
    opacity: 0.96,
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

function roadMeshes(pts: Route["points"], closed: boolean): THREE.Mesh[] {
  const asphalt = asphaltTexture();
  return [
    ribbon(pts, closed, ROAD_WIDTH + 2.2, 0.02, "#b3a483"),
    ribbon(pts, closed, ROAD_WIDTH, 0.05, "#55585f", { map: asphalt }),
    ribbon(pts, closed, ROAD_WIDTH - 0.5, 0.07, "#e8e6dc", { lineWidth: 0.16, offset: (ROAD_WIDTH - 0.5) / 2 }),
    ribbon(pts, closed, 0.16, 0.08, "#f2d75c", { dashed: true }),
  ];
}

function cloudLayers(cx: number, cz: number): { meshes: THREE.Mesh[]; animate: (dt: number) => void } {
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
  group.add(vegetation(index, heightAt, landInfo, region, sampler, false));

  const animate = (dt: number) => {
    sea.animate(dt);
    lakeNormals.offset.x += dt * 0.01;
    clouds.animate(dt);
  };

  return { group, heightAt, animate };
}

/** Pines, round trees, cypresses, bushes and rocks, instanced per kind. */
function vegetation(
  index: RouteIndex,
  heightAt: (x: number, z: number) => number,
  land: Land,
  region: { x0: number; z0: number; w: number; h: number },
  sampler: RouteSampler,
  mediterranean: boolean,
): THREE.Group {
  const g = new THREE.Group();
  const rand = mulberry32(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();

  const trunkMat = new THREE.MeshStandardMaterial({ color: "#6b4a2b", roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9 });
  const rockMat = new THREE.MeshStandardMaterial({ color: "#8d8880", roughness: 1 });

  // Pine: trunk + two stacked cones.
  const pine = new THREE.Group();
  const pineCrown = new THREE.Group();
  const c1 = new THREE.ConeGeometry(2.6, 6, 7);
  c1.translate(0, 5, 0);
  const c2 = new THREE.ConeGeometry(1.8, 5, 7);
  c2.translate(0, 8.5, 0);
  pineCrown.add(new THREE.Mesh(c1), new THREE.Mesh(c2));
  pine.add(pineCrown);

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
  const rock = new THREE.DodecahedronGeometry(1, 0);

  const kinds = mediterranean
    ? {
        pine: { geos: [c1, c2], count: 3000, palette: ["#355f33", "#3f6f38", "#2f5530", "#4a7a3e"] },
        round: { geos: roundCrown, count: 350, palette: ["#5f7f36", "#6b8a3e", "#55702c"] },
        cypress: { geos: [cypress], count: 150, palette: ["#24502a", "#2b5a30", "#1f4524"] },
      }
    : {
        pine: { geos: [c1, c2], count: 1500, palette: ["#2f7d3a", "#3c8f3f", "#2b6b45", "#4a8f3e"] },
        round: { geos: roundCrown, count: 900, palette: ["#3e8a3c", "#4f8f44", "#467a2f", "#5a9a44"] },
        cypress: { geos: [cypress], count: 350, palette: ["#24502a", "#2b5a30", "#1f4524"] },
      };
  const bushes = { count: mediterranean ? 2500 : 1800, palette: mediterranean ? ["#5a6b2e", "#66733a", "#4f5f28"] : ["#5f8233", "#75903f", "#6a7f34"] };
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

  const place = (geos: THREE.BufferGeometry[], count: number, palette: string[], withTrunk: boolean, density: (near: number, x: number, z: number) => number, sizeRange: [number, number], minRoad: number, mat = leafMat, shadows = true) => {
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
    mediterranean ? (fbm(x, z, 350, 5) > 0.4 ? 0.9 : 0.15) : (0.2 + 0.8 * (1 - smoothstep(30, 500, near))) * (fbm(x, z, 300, 5) > 0.42 ? 1 : 0.1);
  place(kinds.pine.geos, kinds.pine.count, kinds.pine.palette, true, forest, [0.7, 1.4], 5);
  place(kinds.round.geos, kinds.round.count, kinds.round.palette, true, (n, x, z) => forest(n, x, z) * (fbm(x, z, 500, 6) > 0.5 ? 1.2 : 0.3), [0.6, 1.1], 6);
  place(kinds.cypress.geos, kinds.cypress.count, kinds.cypress.palette, true, (n) => 0.9 * (1 - smoothstep(12, 120, n)), [0.55, 1.0], 3);
  place([bush], bushes.count, bushes.palette, false, (n) => 0.9 * (1 - smoothstep(5, 200, n)), [0.5, 1.3], 1.6, leafMat, false);
  place([rock], rocks.count, ["#8d8880", "#7d7870", "#9a948a"], false, (n, x, z) => (mediterranean ? 0.4 + 0.6 * smoothstep(0.3, 0.8, land.slope(x, z)) : 0.8 * (1 - smoothstep(6, 160, n))), [0.3, mediterranean ? 2.2 : 1.0], 1.8, rockMat, false);
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
