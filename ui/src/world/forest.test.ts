import { describe, expect, it } from "vitest";
import { cellsIn, parseTrees, type ForestCell, updateCell } from "./forest";

/** A tree file as tools/build_trees.py writes it (before gzip). */
function treeFile(cols: number, rows: number, x0: number, z0: number, cell: number, perCell: [number, number, number][][]): ArrayBuffer {
  const total = perCell.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(20 + 4 * (cols * rows + 1) + 4 * total);
  const v = new DataView(buf);
  v.setUint32(0, cols, true);
  v.setUint32(4, rows, true);
  v.setFloat32(8, x0, true);
  v.setFloat32(12, z0, true);
  v.setFloat32(16, cell, true);
  let o = 0;
  let rec = 20 + 4 * (cols * rows + 1);
  for (let i = 0; i < cols * rows; i++) {
    v.setUint32(20 + 4 * i, o, true);
    for (const [x, z, h] of perCell[i] ?? []) {
      v.setUint32(rec, Math.round(x * 10) | (Math.round(z * 10) << 12) | (Math.round(h * 10) << 24), true);
      rec += 4;
      o++;
    }
  }
  v.setUint32(20 + 4 * cols * rows, o, true);
  return buf;
}

describe("parseTrees", () => {
  it("reads the grid and the packed records", () => {
    const d = parseTrees(treeFile(2, 1, -400, 100, 400, [[[1.5, 399.9, 12.3]], [[0, 0, 4], [200, 200, 25.5]]]));
    expect([d.cols, d.rows, d.x0, d.z0, d.cell]).toEqual([2, 1, -400, 100, 400]);
    expect(Array.from(d.offsets)).toEqual([0, 1, 3]);
    const r = d.recs[0];
    expect((r & 0xfff) / 10).toBeCloseTo(1.5);
    expect(((r >>> 12) & 0xfff) / 10).toBeCloseTo(399.9);
    expect((r >>> 24) / 10).toBeCloseTo(12.3);
    expect((d.recs[2] >>> 24) / 10).toBeCloseTo(25.5);
  });
});

describe("cellsIn", () => {
  const d = parseTrees(treeFile(3, 2, 0, 0, 400, [[[1, 1, 5]], [], [[1, 1, 5]], [[1, 1, 5]], [[1, 1, 5]], [[1, 1, 5]]]));
  it("returns the non-empty cells whose centre lies in the box", () => {
    expect(cellsIn(d, 0, 0, 800, 800)).toEqual([0, 3, 4]);
  });
  it("gives every cell to exactly one of two abutting boxes", () => {
    const a = cellsIn(d, 0, 0, 600, 800);
    const b = cellsIn(d, 600, 0, 1200, 800);
    expect([...a, ...b].sort()).toEqual([0, 2, 3, 4, 5]);
  });
});

describe("updateCell", () => {
  const cell = (): ForestCell => ({
    cx: 200,
    cz: 200,
    half: 200,
    meshes: ["base", "infill"].map((k) => ({ mesh: { visible: false, castShadow: false, geometry: "lite" } as never, full: "full" as never, lite: "lite" as never, infill: k === "infill" })),
    state: { visible: false, lite: true, cast: false, infill: false },
  });
  it("shows full trees, infill and shadows for the cell the rider is in", () => {
    const c = cell();
    updateCell(c, 210, 190);
    const [base, infill] = c.meshes.map((m) => m.mesh as unknown as { visible: boolean; castShadow: boolean; geometry: string });
    expect(base).toMatchObject({ visible: true, castShadow: true, geometry: "full" });
    expect(infill.visible).toBe(true);
  });
  it("keeps measured trees but drops infill 600 m away, with the light model", () => {
    const c = cell();
    updateCell(c, 1000, 200);
    const [base, infill] = c.meshes.map((m) => m.mesh as unknown as { visible: boolean; castShadow: boolean; geometry: string });
    expect(base).toMatchObject({ visible: true, castShadow: false, geometry: "lite" });
    expect(infill.visible).toBe(false);
  });
  it("hides the cell beyond the forest radius", () => {
    const c = cell();
    updateCell(c, 2000, 200);
    expect(c.meshes.every((m) => !(m.mesh as unknown as { visible: boolean }).visible)).toBe(true);
  });
});
