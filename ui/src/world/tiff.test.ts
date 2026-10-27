import { describe, expect, it } from "vitest";
import { parseGeoTiff } from "./tiff";

/** A tiny little-endian, stripped, int16 GeoTIFF with 2x2 pixels, pixel-is-area. */
function tinyTiff(): ArrayBuffer {
  const entries: [number, number, number, number | number[]][] = [
    [256, 3, 1, 2], // width
    [257, 3, 1, 2], // height
    [258, 3, 1, 16], // bits
    [259, 3, 1, 1], // compression none
    [273, 4, 1, 0], // strip offset (patched)
    [278, 3, 1, 2], // rows per strip
    [279, 4, 1, 8], // strip bytes
    [339, 3, 1, 2], // signed
    [33550, 12, 3, [0.5, 0.25, 0]], // pixel scale
    [33922, 12, 6, [0, 0, 0, 10.0, 50.0, 0]], // tie point
    [34735, 3, 8, [1, 1, 0, 1, 1025, 0, 1, 1]], // raster type: area
  ];
  const headerBytes = 8;
  const ifdBytes = 2 + entries.length * 12 + 4;
  let extra = headerBytes + ifdBytes;
  const extraData: [number, number[]][] = [];
  const buf = new ArrayBuffer(512);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949, true);
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true);
  v.setUint16(8, entries.length, true);
  const pixels = extra;
  extra += 8;
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    v.setUint16(o, tag, true);
    v.setUint16(o + 2, type, true);
    v.setUint32(o + 4, count, true);
    if (tag === 273) v.setUint32(o + 8, pixels, true);
    else if (Array.isArray(value)) {
      const size = type === 12 ? 8 : 2;
      if (size * count <= 4) value.forEach((x, k) => v.setUint16(o + 8 + k * 2, x, true));
      else {
        v.setUint32(o + 8, extra, true);
        extraData.push([extra, value.map((x) => (type === 12 ? x : x))]);
        if (type === 12) {
          value.forEach((x, k) => v.setFloat64(extra + k * 8, x, true));
          extra += 8 * count;
        } else {
          value.forEach((x, k) => v.setUint16(extra + k * 2, x, true));
          extra += 2 * count;
        }
      }
    } else if (type === 3) v.setUint16(o + 8, value, true);
    else v.setUint32(o + 8, value, true);
  });
  [100, 200, -5, 7].forEach((x, k) => v.setInt16(pixels + k * 2, x, true));
  return buf;
}

describe("parseGeoTiff", () => {
  it("reads a stripped int16 grid with its georeferencing", () => {
    const g = parseGeoTiff(tinyTiff());
    expect(g.width).toBe(2);
    expect(Array.from(g.data)).toEqual([100, 200, -5, 7]);
    expect(g.dlon).toBe(0.5);
    expect(g.dlat).toBe(0.25);
    expect(g.lon0).toBeCloseTo(10.25);
    expect(g.lat0).toBeCloseTo(49.875);
  });
});
