// Per-pass GPU benchmark. Waits until the world is fully built, stops the game loop,
// then times renderer.render bracketed by gl.finish() (WebKitGTK has no timer queries),
// with each category of the scene removed in turn. Logs "OUT PB <json>" lines.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let w = null;
    for (let i = 0; i < 120 && !(w = wattsup.world()); i++) await sleep(500);
    // Pin the rider to the start point at once: the simulator keeps riding otherwise, and
    // every build would be measured somewhere else.
    w.update = () => {};
    w.speed = 0;
    w.distance = w.targetDistance = window.__startM || 0;
    // Wait for tiles (network worlds) to finish and stay finished.
    let quiet = 0;
    for (let i = 0; i < 400 && quiet < 10; i++) {
      await sleep(500);
      quiet = !w.tiles || w.tiles.pending === 0 ? quiet + 1 : 0;
    }
    await sleep(4000);
    const r = w.renderer;
    const gl = r.getContext();
    const scene = w.scene;
    const cam = w.camera;
    w.running = false; // the game loop stops; the last camera pose stays
    await sleep(300);
    const g = w.statics.group;
    const all = [];
    g.traverse((o) => { if (o.isMesh || o.isInstancedMesh) all.push(o); });
    const kind = (o) => o.userData.kind || "";
    const t = w.tiles;
    const tileGround = t ? [...t.tiles.values()].flatMap((x) => x.ground) : [];
    const farMid = t ? [...t.farMeshes, ...[...t.mids.values()].map((m) => m.mesh).filter(Boolean)] : [];
    const posts = t ? [...t.tiles.values()].flatMap((x) => x.posts.map((p) => p.group)) : [];
    const veg = all.filter((o) => o.isInstancedMesh);
    const roads = all.filter((o) => ["asphalt", "shoulder", "edge", "centre"].includes(kind(o).replace("-tunnel", "")));
    const corridor = all.filter((o) => kind(o) === "corridor");
    const parapet = all.filter((o) => kind(o) === "parapet");
    const sea = all.filter((o) => kind(o) === "sea");
    const clouds = g.children.filter((o) => o.renderOrder === 1);
    const tunnels = [];
    g.traverse((o) => { if (o.isMesh && o.material && (o.material.fog === false) && o.material.vertexColors && o.material.type === "MeshBasicMaterial") tunnels.push(o.parent); });
    const routeGround = !t ? all.filter((o) => !o.isInstancedMesh && !kind(o) && o.material && o.material.map && o.geometry.attributes.position.count > 5000) : [];
    const rider = [w.rider.group];
    // performance.now() has 1 ms resolution in WebKit: time batches of 10 frames.
    const time = (n = 9, batch = 10) => {
      const s = [];
      r.render(scene, cam);
      gl.finish();
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        for (let k = 0; k < batch; k++) r.render(scene, cam);
        gl.finish();
        s.push((performance.now() - t0) / batch);
      }
      s.sort((a, b) => a - b);
      return s[s.length >> 1];
    };
    const hide = (list) => { const prev = list.map((o) => o.visible); list.forEach((o) => (o.visible = false)); return () => list.forEach((o, i) => (o.visible = prev[i])); };
    const cases = [
      ["shadow pass", () => { r.shadowMap.autoUpdate = false; return () => { r.shadowMap.autoUpdate = true; }; }],
      ["tile ground", () => hide(tileGround)],
      ["route ground", () => hide(routeGround)],
      ["far+mid ground", () => hide(farMid)],
      ["corridor", () => hide(corridor)],
      ["roads", () => hide(roads)],
      ["parapets", () => hide(parapet)],
      ["vegetation", () => hide(veg)],
      ["signs", () => hide(posts)],
      ["tunnels", () => hide(tunnels)],
      ["sea", () => hide(sea)],
      ["clouds", () => hide(clouds)],
      ["rider", () => hide(rider)],
      ["photo bandwidth", () => {
        // Upper bound of what compressing the aerial photos could save: every terrain photo swapped for one texel.
        const mats = [...tileGround, ...farMid, ...routeGround].map((m) => m.material).filter((m) => m.map);
        const prev = mats.map((m) => m.map);
        const one = mats.length ? prev[0].clone() : null;
        if (one) { one.image = { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) }; one.isDataTexture = true; one.generateMipmaps = false; one.minFilter = 1006; one.needsUpdate = true; }
        mats.forEach((m) => (m.map = one));
        return () => mats.forEach((m, i) => (m.map = prev[i]));
      }],
      ["sky background", () => { const bg = scene.background; scene.background = null; return () => { scene.background = bg; }; }],
    ];
    const out = { spot: window.__spot || "?", calls: 0, tris: 0, px: {} };
    for (const px of window.__viewOnly ? [] : [1.0, 1.5]) {
      r.setPixelRatio(px);
      w.resize();
      await sleep(200);
      const runs = [];
      for (let run = 0; run < 3; run++) {
        const res = { total: time() };
        out.calls = r.info.render.calls;
        out.tris = r.info.render.triangles;
        for (const [name, off] of cases) {
          const undo = off();
          res[name] = +(res.total - time()).toFixed(2);
          undo();
        }
        const undoAll = hide(all.concat(posts, rider));
        const bg = scene.background;
        scene.background = null;
        r.shadowMap.autoUpdate = false;
        res["empty frame"] = time();
        r.shadowMap.autoUpdate = true;
        scene.background = bg;
        undoAll();
        res.total = +res.total.toFixed(2);
        res["empty frame"] = +res["empty frame"].toFixed(2);
        runs.push(res);
        await sleep(100);
      }
      // Median over the runs per key.
      const med = {};
      for (const k of Object.keys(runs[0])) {
        const v = runs.map((x) => x[k]).sort((a, b) => a - b);
        med[k] = v[1];
      }
      med.spread = +(Math.max(...runs.map((x) => x.total)) - Math.min(...runs.map((x) => x.total))).toFixed(2);
      out.px[px] = med;
    }
    out.size = [r.domElement.width, r.domElement.height];
    console.warn("OUT PB " + JSON.stringify(out));
    r.setPixelRatio(1.0);
    w.resize();
    // Keep presenting the measured view so a screenshot shows exactly what was timed.
    const show = () => { r.render(scene, cam); requestAnimationFrame(show); };
    requestAnimationFrame(show);
    await sleep(1500);
    console.warn("OUT PB-DONE " + cam.position.toArray().map((v) => v.toFixed(2)).join(","));
  } catch (e) {
    console.warn("OUT PB error " + e + " " + e.stack);
  }
})();
