// Finds where the ground pokes through the road on a single route, all of it, from above.
//
//   WATTSUP_SCREEN=ride WATTSUP_ROUTE=malaga-colmenar WATTSUP_DEV_JS="$(cat tools/dev/clipcheck.js)" npm run tauri dev
//
// Every 80 m of route an orthographic camera looks straight down at 0.25 m a pixel and
// renders twice: the asphalt alone (the mask), then asphalt and ground (corridor strip and
// terrain grids) in two flat colours with the depth test on. A mask pixel that comes out
// ground is ground above the road surface. Logs "OUT CLIP <metres along> <pixels>" (split into
// corridor strip and terrain grid) for each
// window with any, and "OUT CLIP-DONE <windows> <windows with clipping>". The ground is
// whatever opaque mesh has no userData.kind or the kind "corridor"; the scene goes back as it was.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let w = null;
    for (let i = 0; i < 240 && !(w = wattsup.world()); i++) await sleep(500);
    await sleep(6000);
    w = wattsup.world();
    const T = wattsup.three;
    const r = w.renderer;
    const pts = w.sampler.route.points;
    const all = [];
    w.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine || o.isSprite) all.push(o); });
    const kind = (o) => o.userData.kind || "";
    const isRoad = (o) => kind(o) === "asphalt";
    // Clouds have no kind either, but they are transparent (and on the high parts of a climb they lie between camera and road).
    const isGround = (o) => o.isMesh && !o.isInstancedMesh && (kind(o) === "" || kind(o) === "corridor") && o.material && !o.material.isShaderMaterial && !o.material.transparent;
    const saved = all.map((o) => [o, o.visible, o.material]);
    const savedMat = new Map(saved.map(([o, , m]) => [o, m]));
    const white = new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, fog: false });
    const red = new T.MeshBasicMaterial({ color: 0xff0000, side: T.DoubleSide, fog: false });
    const blue = new T.MeshBasicMaterial({ color: 0x0000ff, side: T.DoubleSide, fog: false });
    const S = 400;
    const M = 0.25;
    const rt = new T.WebGLRenderTarget(S, S);
    const mask = new Uint8Array(S * S * 4);
    const both = new Uint8Array(S * S * 4);
    const cam = new T.OrthographicCamera((-S * M) / 2, (S * M) / 2, (S * M) / 2, (-S * M) / 2, 1, 600);
    const bg = w.scene.background;
    w.scene.background = null;
    const tone = r.toneMapping;
    r.toneMapping = T.NoToneMapping;
    w.running = false;
    await sleep(200);
    const step = 80;
    const total = pts[pts.length - 1].distance_m;
    let windows = 0;
    let bad = 0;
    for (let d = 40; d < total; d += step) {
      const i = Math.min(pts.length - 1, Math.round(d / (pts[1].distance_m || 5)));
      const p = pts[i];
      cam.position.set(p.x, p.y + 200, p.z);
      cam.up.set(0, 0, -1);
      cam.lookAt(p.x, p.y, p.z);
      cam.updateMatrixWorld();
      for (const [o] of saved) { o.visible = isRoad(o); if (isRoad(o)) o.material = white; }
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.render(w.scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, S, S, mask);
      // The corridor strip red, everything else of the ground (terrain grids) blue.
      for (const [o] of saved) { o.visible = isRoad(o) || isGround(o); if (isGround(o)) o.material = kind(o) === "corridor" ? red : blue; }
      r.clear();
      r.render(w.scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, S, S, both);
      let nc = 0;
      let ng = 0;
      // Where the clipping pixels lie in the world (the camera looks down with -z up: +x right, row 0 at +z).
      let sx = 0;
      let sz = 0;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < S * S; k++) {
        if (mask[k * 4] < 128 || both[k * 4 + 1] > 64) continue;
        if (both[k * 4] > 128) nc++;
        else if (both[k * 4 + 2] > 128) ng++;
        else continue;
        const x = p.x + ((k % S) - S / 2 + 0.5) * M;
        const z = p.z - (Math.floor(k / S) - S / 2 + 0.5) * M;
        sx += x; sz += z;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      windows++;
      const n = nc + ng;
      if (n > 8) {
        bad++;
        // Which meshes: each ground mesh alone with the road, the worst three named by size.
        const blame = [];
        for (const [o] of saved) {
          if (!isGround(o)) continue;
          for (const [q] of saved) q.visible = isRoad(q) || q === o;
          r.clear();
          r.render(w.scene, cam);
          r.readRenderTargetPixels(rt, 0, 0, S, S, both);
          let m = 0;
          for (let k = 0; k < S * S; k++) if (mask[k * 4] > 128 && both[k * 4 + 1] < 64 && (both[k * 4] > 128 || both[k * 4 + 2] > 128)) m++;
          if (m > 0) {
            o.geometry.computeBoundingBox();
            const b = o.geometry.boundingBox;
            blame.push(`${m}px:${kind(o) || savedMat.get(o)?.type}/${o.geometry.attributes.position.count}v/${Math.round(b.max.x - b.min.x)}x${Math.round(b.max.z - b.min.z)}m`);
          }
        }
        blame.sort((a, b) => parseInt(b) - parseInt(a));
        console.warn(`OUT CLIP ${Math.round(d)} ${n} corridor ${nc} grid ${ng} centre ${(sx / n).toFixed(0)},${(sz / n).toFixed(0)} box ${x0.toFixed(0)}..${x1.toFixed(0)},${z0.toFixed(0)}..${z1.toFixed(0)} by ${blame.slice(0, 3).join(" ")}`);
      }
      if (windows % 20 === 0) await sleep(0);
    }
    r.setRenderTarget(null);
    for (const [o, vis, mat] of saved) { o.visible = vis; o.material = mat; }
    w.scene.background = bg;
    r.toneMapping = tone;
    w.running = true;
    console.warn(`OUT CLIP-DONE ${windows} ${bad}`);
  } catch (e) {
    console.warn(`OUT CLIP error ${e && e.stack ? e.stack : e}`);
  }
})();
