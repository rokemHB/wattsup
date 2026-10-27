// Procedural, tileable textures drawn on canvases: no image files to ship.
import * as THREE from "three";
import { fbmTile, mulberry32 } from "./noise";

function canvasTexture(size: number, paint: (ctx: CanvasRenderingContext2D) => void, repeat = 1): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  paint(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Writes per-pixel colours from a function of (u, v) in [0, 1). */
function paintPixels(size: number, px: (u: number, v: number) => [number, number, number, number?]) {
  return (ctx: CanvasRenderingContext2D) => {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b, a = 255] = px(x / size, y / size);
        const i = (y * size + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
}

/** Mottled grass, multiplied with the terrain's vertex colours. */
export function grassTexture(): THREE.CanvasTexture {
  const size = 256;
  const rand = mulberry32(7);
  return canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 8, 21);
      const fine = fbmTile(u, v, 32, 22);
      const g = 150 + (n - 0.5) * 70 + (fine - 0.5) * 50 + (rand() - 0.5) * 12;
      return [g * 0.9, g, g * 0.72];
    }),
    1,
  );
}

/** Asphalt with light aggregate speckle. */
export function asphaltTexture(): THREE.CanvasTexture {
  const size = 256;
  const rand = mulberry32(3);
  return canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 16, 31);
      const g = 120 + (n - 0.5) * 30 + (rand() - 0.5) * 28;
      return [g, g + 1, g + 4];
    }),
    1,
  );
}

/** Rock face for the far mountains. */
export function rockTexture(): THREE.CanvasTexture {
  const size = 256;
  return canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 6, 41);
      const strata = 0.5 + 0.5 * Math.sin(v * 40 + fbmTile(u, v, 4, 42) * 6);
      const g = 128 + (n - 0.5) * 60 + strata * 20;
      return [g * 1.05, g, g * 0.9];
    }),
    1,
  );
}

/** Cloud cover as an alpha map: white where there is cloud. */
export function cloudTexture(coverage: number, seed: number): THREE.CanvasTexture {
  const size = 512;
  const tex = canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 5, seed) + 0.25 * fbmTile(u, v, 20, seed + 1);
      const a = Math.min(1, Math.max(0, (n - (1 - coverage) * 1.05) * 4));
      const shade = 230 + 25 * a;
      return [shade, shade, shade + 5, Math.round(a * a * 255)];
    }),
    1,
  );
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** A tangent-space normal map of gentle ripples for the water. */
export function waterNormalTexture(): THREE.CanvasTexture {
  const size = 256;
  const h = (u: number, v: number) => fbmTile(u, v, 12, 51) + 0.5 * fbmTile(u + 0.3, v + 0.7, 28, 52);
  const e = 1 / size;
  const tex = canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const dx = (h(u + e, v) - h(u - e, v)) * 6;
      const dy = (h(u, v + e) - h(u, v - e)) * 6;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      return [(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255];
    }),
    1,
  );
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Neutral grey grain, multiplied over aerial imagery up close where the photo blurs. */
export function detailTexture(): THREE.CanvasTexture {
  const size = 256;
  const rand = mulberry32(5);
  const tex = canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 10, 71);
      const fine = fbmTile(u, v, 40, 72);
      const g = 200 + (n - 0.5) * 70 + (fine - 0.5) * 60 + (rand() - 0.5) * 20;
      return [g, g, g];
    }),
    1,
  );
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Tiling limestone: pale grey with cracks and darker pockets. Mean brightness about 0.5 so it modulates a photo neutrally. */
export function rockDetailTexture(): THREE.CanvasTexture {
  const size = 512;
  const rand = mulberry32(9);
  return canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 6, 81);
      const fine = fbmTile(u, v, 24, 82);
      const crack = Math.pow(Math.abs(fbmTile(u, v, 10, 83) - 0.5) * 2, 0.35);
      const g = 128 + (n - 0.5) * 46 + (fine - 0.5) * 30 - (1 - crack) * 40 + (rand() - 0.5) * 10;
      return [g * 1.02, g, g * 0.94];
    }),
    1,
  );
}

/** Tiling scrub and bare earth, olive and ochre, mean about 0.5. */
export function scrubDetailTexture(): THREE.CanvasTexture {
  const size = 512;
  const rand = mulberry32(10);
  return canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const n = fbmTile(u, v, 5, 91);
      const tufts = Math.max(0, fbmTile(u, v, 23, 92) - 0.5) * 2;
      const earth = 128 + (n - 0.5) * 34 + (rand() - 0.5) * 16;
      const r = earth * 1.0 - tufts * 26;
      const g = earth * 0.98 + tufts * 6;
      const b = earth * 0.84 - tufts * 26;
      return [r, g, b];
    }),
    1,
  );
}

/** A tangent-space normal map of rocky bumps for the terrain. */
export function rockNormalTexture(): THREE.CanvasTexture {
  const size = 512;
  const h = (u: number, v: number) => fbmTile(u, v, 6, 101) + 0.5 * fbmTile(u, v, 18, 102) + 0.25 * fbmTile(u, v, 50, 103);
  const e = 1 / size;
  const tex = canvasTexture(
    size,
    paintPixels(size, (u, v) => {
      const dx = (h(u + e, v) - h(u - e, v)) * 14;
      const dy = (h(u, v + e) - h(u, v - e)) * 14;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      return [(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255];
    }),
    1,
  );
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}
