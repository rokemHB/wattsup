// A small reader for the GeoTIFFs the IGN coverage service returns:
// uncompressed, tiled or stripped, 16-bit signed or 32-bit float, one band,
// with the tie point and pixel scale tags for georeferencing.

export interface GeoGrid {
  width: number;
  height: number;
  data: Float32Array;
  /** Longitude and latitude of the centre of the top-left pixel. */
  lon0: number;
  lat0: number;
  dlon: number;
  dlat: number;
}

export function parseGeoTiff(buffer: ArrayBuffer): GeoGrid {
  const view = new DataView(buffer);
  const order = view.getUint16(0, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) throw new Error("not a TIFF");
  if (view.getUint16(2, little) !== 42) throw new Error("not a classic TIFF");
  const ifd = view.getUint32(4, little);
  const count = view.getUint16(ifd, little);
  const tags = new Map<number, { type: number; count: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    const o = ifd + 2 + i * 12;
    tags.set(view.getUint16(o, little), { type: view.getUint16(o + 2, little), count: view.getUint32(o + 4, little), offset: o + 8 });
  }
  const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };
  const values = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const size = sizes[t.type] ?? 1;
    const total = size * t.count;
    const base = total <= 4 ? t.offset : view.getUint32(t.offset, little);
    const out: number[] = [];
    for (let i = 0; i < t.count; i++) {
      const p = base + i * size;
      switch (t.type) {
        case 3:
          out.push(view.getUint16(p, little));
          break;
        case 4:
          out.push(view.getUint32(p, little));
          break;
        case 8:
          out.push(view.getInt16(p, little));
          break;
        case 9:
          out.push(view.getInt32(p, little));
          break;
        case 11:
          out.push(view.getFloat32(p, little));
          break;
        case 12:
          out.push(view.getFloat64(p, little));
          break;
        default:
          out.push(view.getUint8(p));
      }
    }
    return out;
  };
  const width = values(256)[0];
  const height = values(257)[0];
  const bits = values(258)[0] ?? 16;
  const compression = values(259)[0] ?? 1;
  const format = values(339)[0] ?? 1; // 1 unsigned, 2 signed, 3 float
  if (compression !== 1) throw new Error(`compressed TIFF (${compression}) not supported`);
  const read = (offset: number): number => {
    if (bits === 16) return format === 2 ? view.getInt16(offset, little) : view.getUint16(offset, little);
    if (bits === 32 && format === 3) return view.getFloat32(offset, little);
    if (bits === 32) return format === 2 ? view.getInt32(offset, little) : view.getUint32(offset, little);
    if (bits === 8) return format === 2 ? view.getInt8(offset) : view.getUint8(offset);
    throw new Error(`unsupported sample: ${bits} bits, format ${format}`);
  };
  const bytes = bits / 8;
  const data = new Float32Array(width * height);
  const tileWidth = values(322)[0];
  if (tileWidth) {
    const tileHeight = values(323)[0];
    const offsets = values(324);
    const across = Math.ceil(width / tileWidth);
    for (let t = 0; t < offsets.length; t++) {
      const tx = (t % across) * tileWidth;
      const ty = Math.floor(t / across) * tileHeight;
      for (let y = 0; y < tileHeight; y++) {
        const py = ty + y;
        if (py >= height) break;
        for (let x = 0; x < tileWidth; x++) {
          const px = tx + x;
          if (px >= width) break;
          data[py * width + px] = read(offsets[t] + (y * tileWidth + x) * bytes);
        }
      }
    }
  } else {
    const offsets = values(273);
    const rowsPerStrip = values(278)[0] ?? height;
    for (let s = 0; s < offsets.length; s++) {
      for (let y = 0; y < rowsPerStrip; y++) {
        const py = s * rowsPerStrip + y;
        if (py >= height) break;
        for (let x = 0; x < width; x++) data[py * width + x] = read(offsets[s] + (y * width + x) * bytes);
      }
    }
  }
  const tie = values(33922);
  const scale = values(33550);
  const keys = values(34735);
  // GTRasterTypeGeoKey 1025: 1 = pixel is area (tie point at the corner), 2 = pixel is point.
  let rasterType = 1;
  for (let i = 4; i + 3 < keys.length; i += 4) if (keys[i] === 1025) rasterType = keys[i + 3];
  const dlon = scale[0];
  const dlat = scale[1];
  const lon0 = tie[3] + (rasterType === 1 ? dlon / 2 : 0);
  const lat0 = tie[4] - (rasterType === 1 ? dlat / 2 : 0);
  // No-data in this model is a huge negative; treat anything under -500 m as sea.
  for (let i = 0; i < data.length; i++) if (data[i] < -500) data[i] = 0;
  return { width, height, data, lon0, lat0, dlon, dlat };
}
