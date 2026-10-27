// Small deterministic value noise for terrain and tree placement. No dependency needed.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [0, 1] with period `scale` metres. */
export function noise2(x: number, z: number, scale: number, seed = 1): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smooth(fx - ix);
  const tz = smooth(fz - iz);
  const a = hash(ix, iz, seed);
  const b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed);
  const d = hash(ix + 1, iz + 1, seed);
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Three octaves of value noise, roughly in [0, 1]. */
export function fbm(x: number, z: number, scale: number, seed = 1): number {
  return 0.6 * noise2(x, z, scale, seed) + 0.28 * noise2(x, z, scale / 2.3, seed + 7) + 0.12 * noise2(x, z, scale / 5.1, seed + 13);
}

/** Value noise that tiles every `period` lattice cells, for seamless textures. */
export function noise2p(u: number, v: number, period: number, seed = 1): number {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const tu = smooth(u - iu);
  const tv = smooth(v - iv);
  const w = (a: number, b: number) => hash(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = w(iu, iv);
  const b = w(iu + 1, iv);
  const c = w(iu, iv + 1);
  const d = w(iu + 1, iv + 1);
  return (a + (b - a) * tu) * (1 - tv) + (c + (d - c) * tu) * tv;
}

/** Tileable fbm over the unit square. */
export function fbmTile(x: number, y: number, cells: number, seed = 1): number {
  return (
    0.55 * noise2p(x * cells, y * cells, cells, seed) +
    0.3 * noise2p(x * cells * 2, y * cells * 2, cells * 2, seed + 3) +
    0.15 * noise2p(x * cells * 4, y * cells * 4, cells * 4, seed + 9)
  );
}
