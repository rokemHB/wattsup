// The app's screens: start, main menu, rider, settings, the ride with its HUD
// and minimap, pause and finish. The 3D world runs behind all of them.
import { api, insideTauri } from "./api";
import { applyStoredDrivetrain, latest, renderDebug, scan, showError, wireDebug } from "./debug";
import { $, el } from "./dom";
import { duration, isTypingTarget, num, shiftForKey } from "./format";
import { drawWorkout, Hud } from "./hud";
import { Minimap, type NetworkView } from "./minimap";
import { ACCENTS, AVATARS, BIKES, JERSEYS, loadProfile, type Profile, saveProfile } from "./profile";
import type { EngineSnapshot, Junction, Place, Route, RouteInfo, Turn, Workout } from "./types";
import { loadNetwork, NetworkIndex, type RoadNetwork } from "./world/network";
import { Frame } from "./world/streaming";
import { describe, fromPreset, loadFtp, loadWorkouts, PRESETS, saveFtp, saveWorkouts, validStep } from "./workouts";
import { loadNetworkWorld, loadWorld, type NetworkWorldData, type WorldData } from "./world/terrain";
import { World } from "./world/world";

type Screen = "start" | "menu" | "rider" | "settings" | "workout" | "map" | "ride" | "pause" | "finish";

let screen: Screen = "start";
let cameFrom: Screen = "menu";
let world: World | null = null;
let hud: Hud | null = null;
let minimap: Minimap | null = null;
let route: Route | null = null;
let routes: RouteInfo[] = [];
let selectedRoute = "";
let profile: Profile = loadProfile();
/** The rider screen edits a draft; Save makes it the profile, Back throws it away. */
let draft: Profile = { ...profile };
let finishShown = false;
let workouts: Workout[] = loadWorkouts();
let ftp = loadFtp();
/** The workout open in the editor and its index in the saved list (-1 = new). */
let editing: Workout = { name: "", steps: [] };
let editingIndex = -1;
let activeWorkout: Workout | null = null;
/** The island: road network and streamed world, loaded when first needed. */
const NETWORK_WORLD = "mallorca";
let network: RoadNetwork | null = null;
let networkIndex: NetworkIndex | null = null;
let networkWorld: NetworkWorldData | null = null;
let routeVersion = -1;
let lastJunctionKey = "";
const stats = { samples: 0, power: 0, hr: 0, hrSamples: 0 };

// --- screens -----------------------------------------------------------------

function show(next: Screen) {
  if (next === "settings" || next === "rider" || next === "workout" || next === "map") cameFrom = screen === "pause" ? "pause" : "menu";
  if (next === "rider") draft = { ...profile };
  screen = next;
  for (const s of ["start", "menu", "rider", "settings", "workout", "map", "pause", "finish"]) $(`screen-${s}`).hidden = s !== next;
  if (next === "map") requestAnimationFrame(drawMap);
  if (next === "pause") $("pause-end-workout").hidden = !activeWorkout;
  if (next === "menu") fillWorkoutList();
  $("hud").hidden = !(next === "ride" || next === "pause" || next === "finish");
  if (next === "rider") fillRiderScreen();
  world?.setCamera(next === "ride" || next === "pause" || next === "finish" ? "chase" : "orbit");
}

function back() {
  if (screen === "rider") {
    draft = { ...profile };
    applyProfile(profile);
  }
  show(cameFrom);
}

// --- rider profile -------------------------------------------------------------

/** Shows a profile everywhere: badges and the 3D rider. Does not store it. */
function applyProfile(p: Profile) {
  for (const id of ["menu-avatar", "hud-avatar"]) $(id).textContent = p.avatar;
  for (const id of ["menu-name", "hud-name"]) $(id).textContent = p.name || "Rider";
  world?.setRider(p.jersey, p.accent, p.bike);
}

function draftChanged(): boolean {
  return (Object.keys(profile) as (keyof Profile)[]).some((k) => profile[k] !== draft[k]);
}

function previewDraft() {
  applyProfile(draft);
  $<HTMLButtonElement>("rider-save").disabled = !draftChanged();
}

function saveDraft() {
  profile = { ...draft, name: draft.name.trim() || "Rider" };
  saveProfile(profile);
  applyProfile(profile);
  $<HTMLButtonElement>("rider-save").disabled = true;
}

function choices(id: string, options: string[], current: string, pick: (v: string) => void, swatch: boolean) {
  const box = $(id);
  box.replaceChildren(
    ...options.map((v) => {
      const b = el("button", { className: v === current ? "on" : "", title: v });
      if (swatch) b.style.background = v;
      else b.textContent = v;
      b.onclick = () => {
        pick(v);
        previewDraft();
        fillRiderScreen();
      };
      return b;
    }),
  );
}

function fillRiderScreen() {
  const name = $<HTMLInputElement>("rider-name");
  if (document.activeElement !== name) name.value = draft.name;
  choices("rider-avatars", AVATARS, draft.avatar, (v) => (draft.avatar = v), false);
  choices("rider-jerseys", JERSEYS, draft.jersey, (v) => (draft.jersey = v), true);
  choices("rider-accents", ACCENTS, draft.accent, (v) => (draft.accent = v), true);
  choices("rider-bikes", BIKES, draft.bike, (v) => (draft.bike = v), true);
  $<HTMLButtonElement>("rider-save").disabled = !draftChanged();
}

// --- workouts ------------------------------------------------------------------

function fillWorkoutList() {
  const card = (w: Workout, onEdit: () => void, saved: boolean) => {
    const c = el(
      "div",
      { className: "route-card" },
      el("b", {}, w.name),
      el("button", { className: "primary", textContent: saved ? "Edit" : "Open" }),
      el("span", { className: "meta" }, describe(w)),
    );
    c.onclick = onEdit;
    return c;
  };
  $("workout-list").replaceChildren(
    ...workouts.map((w, i) => card(w, () => openWorkout(w, i), true)),
    ...PRESETS.map((p) => card(fromPreset(p, ftp), () => openWorkout(fromPreset(p, ftp), -1), false)),
  );
}

function openWorkout(w: Workout, index: number) {
  editing = { name: w.name, steps: w.steps.map((s) => ({ ...s })) };
  editingIndex = index;
  show("workout");
  fillWorkoutEditor();
}

function fillWorkoutEditor() {
  $<HTMLInputElement>("workout-name").value = editing.name;
  $<HTMLInputElement>("workout-ftp").value = String(ftp);
  const preset = $<HTMLSelectElement>("workout-preset");
  preset.replaceChildren(el("option", { value: "", textContent: "Load a preset…" }), ...PRESETS.map((p, i) => el("option", { value: String(i), textContent: p.name })));
  const routeSel = $<HTMLSelectElement>("workout-route");
  const current = routeSel.value || "flat";
  routeSel.replaceChildren(...routes.map((r) => el("option", { value: r.id, textContent: r.name })));
  routeSel.value = routes.some((r) => r.id === current) ? current : routes[0]?.id ?? "";
  $("workout-delete").hidden = editingIndex < 0;
  $("workout-steps").replaceChildren(
    ...editing.steps.map((step, i) => {
      const numberInput = (min: string, max: string, stepSize: string, value: number) => {
        const input = document.createElement("input");
        input.type = "number";
        input.min = min;
        input.max = max;
        input.step = stepSize;
        input.value = String(value);
        return input;
      };
      const watts = numberInput("0", "1500", "5", step.watts);
      const minutes = numberInput("0.5", "180", "0.5", step.seconds / 60);
      watts.addEventListener("input", () => {
        step.watts = Number(watts.value);
        refreshWorkoutSummary();
      });
      minutes.addEventListener("input", () => {
        step.seconds = Number(minutes.value) * 60;
        refreshWorkoutSummary();
      });
      const remove = el("button", { className: "small", textContent: "×" });
      remove.onclick = () => {
        editing.steps.splice(i, 1);
        fillWorkoutEditor();
      };
      const row = el("div", { className: "step-row" });
      const wattsField = el("label", { className: "row" });
      wattsField.append(watts, el("span", {}, "W"));
      const minutesField = el("label", { className: "row" });
      minutesField.append(minutes, el("span", {}, "min"));
      row.append(el("span", {}, String(i + 1)), wattsField, minutesField, remove);
      return row;
    }),
  );
  refreshWorkoutSummary();
}

function refreshWorkoutSummary() {
  const ok = editing.steps.length > 0 && editing.steps.every(validStep);
  $("workout-summary").textContent = ok ? describe(editing) : editing.steps.length ? "every step needs watts and a duration" : "add a step or load a preset";
  $<HTMLButtonElement>("workout-start").disabled = !ok;
  $<HTMLButtonElement>("workout-save").disabled = !ok;
  if (ok) drawWorkout($("workout-preview") as HTMLCanvasElement, editing, 0);
}

function saveWorkout() {
  const w: Workout = { name: editing.name.trim() || "Workout", steps: editing.steps.map((s) => ({ ...s })) };
  if (editingIndex >= 0) workouts[editingIndex] = w;
  else {
    workouts.push(w);
    editingIndex = workouts.length - 1;
  }
  saveWorkouts(workouts);
  fillWorkoutList();
  show("menu");
}

async function startWorkout() {
  const w: Workout = { name: editing.name.trim() || "Workout", steps: editing.steps.map((s) => ({ ...s })) };
  const routeId = $<HTMLSelectElement>("workout-route").value || selectedRoute;
  await startRide(routeId);
  await api.startWorkout(w);
  activeWorkout = w;
  hud?.setWorkout(w);
}

async function endWorkout() {
  if (!activeWorkout) return;
  activeWorkout = null;
  hud?.setWorkout(null);
  await api.stopWorkout();
}

// --- the island map --------------------------------------------------------------

interface MapView {
  /** Map pixel at the canvas origin and pixels per canvas pixel. */
  ox: number;
  oy: number;
  scale: number;
  dragging: { x: number; y: number; ox: number; oy: number } | null;
}
const mapView: MapView = { ox: 0, oy: 0, scale: 1, dragging: null };
let mapSel: { x: number; z: number; edge: number; i: number } | null = null;
/** The roads as canvas paths in map-image pixels, built once per network: stroking a path is cheap, rebuilding it every frame was not. */
let mapPaths: { byKind: { kind: number; path: Path2D }[]; bounds: { x0: number; y0: number; x1: number; y1: number }; places: Place[] } | null = null;

function buildMapPaths() {
  const net = network!;
  const xyz = net.xyz;
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const byKind = [3, 2, 1, 0].map((kind) => ({ kind, path: new Path2D() }));
  for (const e of net.edges) {
    const path = byKind.find((k) => k.kind === e.kind)?.path ?? byKind[0].path;
    for (let i = e.start; i < e.start + e.count; i++) {
      const [px, py] = mapPixel(xyz[i * 3], xyz[i * 3 + 2]);
      if (i === e.start) path.moveTo(px, py);
      else path.lineTo(px, py);
      if (px < bounds.x0) bounds.x0 = px;
      if (px > bounds.x1) bounds.x1 = px;
      if (py < bounds.y0) bounds.y0 = py;
      if (py > bounds.y1) bounds.y1 = py;
    }
  }
  // Only the places along the rideable roads get a label; the rest of the island is just the picture.
  const places = net.places.filter((pl) => networkIndex!.nearest(pl.x, pl.z, 2500).d < 2500);
  mapPaths = { byKind, bounds, places };
  return mapPaths;
}

async function ensureNetwork(): Promise<boolean> {
  if (network && networkWorld) return true;
  try {
    const [net, data] = await Promise.all([loadNetwork(NETWORK_WORLD), loadNetworkWorld(NETWORK_WORLD)]);
    if (!net) return false;
    network = net;
    networkIndex = new NetworkIndex(net);
    networkWorld = data;
    mapPaths = null;
    return true;
  } catch (e) {
    showError(`island not available: ${e}`);
    return false;
  }
}

async function openMap() {
  $("loading-text").textContent = "Loading the island…";
  $("loading").hidden = false;
  const ok = await ensureNetwork();
  $("loading").hidden = true;
  if (!ok) return;
  $("map-title").textContent = networkWorld!.name;
  mapSel = null;
  mapView.scale = 0;
  for (const id of ["map-ride-a", "map-ride-b"]) {
    $<HTMLButtonElement>(id).disabled = true;
    $(id).textContent = "Ride";
  }
  $("map-hint").textContent = "Click a road to start there. Scroll to zoom, drag to pan.";
  show("map");
}

/** Map image pixel of a local position. */
let mapFrame: Frame | null = null;
function mapPixel(x: number, z: number): [number, number] {
  const w = networkWorld!;
  const m = w.map!;
  if (!mapFrame || mapFrame.lat0 !== w.origin.lat || mapFrame.lon0 !== w.origin.lon) mapFrame = new Frame(w.origin.lat, w.origin.lon);
  const [lat, lon] = mapFrame.toLatLon(x, z);
  return [((lon - m.lon_min) / (m.lon_max - m.lon_min)) * m.image.width, ((m.lat_max - lat) / (m.lat_max - m.lat_min)) * m.image.height];
}

function drawMap() {
  if (!networkWorld?.map || !network || screen !== "map") return;
  const canvas = $<HTMLCanvasElement>("map-canvas");
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const img = networkWorld.map.image;
  const paths = mapPaths ?? buildMapPaths();
  if (!mapView.scale) {
    // Fit the roads' extent: the Tramuntana, not the whole island.
    const b = paths.bounds;
    mapView.scale = Math.max((b.x1 - b.x0) / w, (b.y1 - b.y0) / h) * 1.05;
    mapView.ox = (b.x0 + b.x1) / 2 - (w / 2) * mapView.scale;
    mapView.oy = (b.y0 + b.y1) / 2 - (h / 2) * mapView.scale;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0b0d14";
  ctx.fillRect(0, 0, w, h);
  const s = mapView.scale;
  // Only the part of the image inside the view: WebKit draws nothing when the source rectangle leaves the image.
  const sx0 = Math.max(0, mapView.ox);
  const sy0 = Math.max(0, mapView.oy);
  const sx1 = Math.min(img.width, mapView.ox + w * s);
  const sy1 = Math.min(img.height, mapView.oy + h * s);
  if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - mapView.ox) / s, (sy0 - mapView.oy) / s, (sx1 - sx0) / s, (sy1 - sy0) / s);
  const toCanvas = (x: number, z: number) => {
    const [px, py] = mapPixel(x, z);
    return [(px - mapView.ox) / s, (py - mapView.oy) / s] as const;
  };
  // Roads: prebuilt paths in map-image pixels, drawn through the view transform.
  ctx.save();
  ctx.setTransform(dpr / s, 0, 0, dpr / s, (-mapView.ox * dpr) / s, (-mapView.oy * dpr) / s);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const { kind, path } of paths.byKind) {
    ctx.strokeStyle = kind === 0 ? "#ffd166" : kind === 1 ? "#ffffff" : kind === 2 ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = (kind <= 1 ? 2.2 : 1.2) * s;
    ctx.stroke(path);
  }
  ctx.restore();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "bold 12px sans-serif";
  for (const pl of paths.places) {
    if (pl.kind === "hamlet" && s > 6) continue;
    if (pl.kind === "village" && s > 12) continue;
    const [cx, cy] = toCanvas(pl.x, pl.z);
    if (cx < 0 || cy < 0 || cx > w || cy > h) continue;
    ctx.fillStyle = "#0f121b";
    ctx.fillText(pl.name, cx + 7, cy + 5);
    ctx.fillStyle = pl.kind === "town" || pl.kind === "city" ? "#ffffff" : "rgba(255,255,255,0.8)";
    ctx.fillText(pl.name, cx + 6, cy + 4);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  if (mapSel) {
    const [cx, cy] = toCanvas(mapSel.x, mapSel.z);
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,196,0,0.35)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffc400";
    ctx.stroke();
  }
}

/** A short name for riding an edge toward one of its ends: the nearest town past that end, or the compass direction. */
function directionLabel(edge: number, towardB: boolean): string {
  const net = network!;
  const e = net.edges[edge];
  const node = net.nodes[towardB ? e.b : e.a];
  let best: { name: string; d: number } | null = null;
  for (const pl of net.places) {
    if (pl.kind === "hamlet") continue;
    const d = Math.hypot(pl.x - node.x, pl.z - node.z);
    if (d < 6000 && (!best || d < best.d)) best = { name: pl.name, d };
  }
  const road = e.ref ?? e.name ?? "road";
  if (best) return `${road} toward ${best.name}`;
  const from = net.nodes[towardB ? e.a : e.b];
  const dx = node.x - from.x;
  const dz = node.z - from.z;
  const dirs = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];
  const idx = Math.round((Math.atan2(dz, dx) / (Math.PI / 4) + 8) % 8);
  return `${road} ${dirs[idx]}`;
}

/** One redraw per frame, however many wheel or mouse events arrive. */
let mapDrawQueued = false;
function scheduleMapDraw() {
  if (mapDrawQueued) return;
  mapDrawQueued = true;
  requestAnimationFrame(() => {
    mapDrawQueued = false;
    drawMap();
  });
}

function wireMap() {
  const canvas = $<HTMLCanvasElement>("map-canvas");
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
    const ns = Math.min(40, Math.max(0.5, mapView.scale * factor));
    mapView.ox += mx * (mapView.scale - ns);
    mapView.oy += my * (mapView.scale - ns);
    mapView.scale = ns;
    scheduleMapDraw();
  });
  canvas.addEventListener("mousedown", (e) => (mapView.dragging = { x: e.clientX, y: e.clientY, ox: mapView.ox, oy: mapView.oy }));
  window.addEventListener("mousemove", (e) => {
    if (!mapView.dragging) return;
    mapView.ox = mapView.dragging.ox - (e.clientX - mapView.dragging.x) * mapView.scale;
    mapView.oy = mapView.dragging.oy - (e.clientY - mapView.dragging.y) * mapView.scale;
    scheduleMapDraw();
  });
  window.addEventListener("mouseup", (e) => {
    const drag = mapView.dragging;
    mapView.dragging = null;
    if (!drag || !networkIndex || !networkWorld?.map || screen !== "map") return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) return; // it was a pan
    const rect = canvas.getBoundingClientRect();
    const px = mapView.ox + (e.clientX - rect.left) * mapView.scale;
    const py = mapView.oy + (e.clientY - rect.top) * mapView.scale;
    const m = networkWorld.map;
    const lon = m.lon_min + (px / m.image.width) * (m.lon_max - m.lon_min);
    const lat = m.lat_max - (py / m.image.height) * (m.lat_max - m.lat_min);
    const [x, z] = new Frame(networkWorld.origin.lat, networkWorld.origin.lon).toXZ(lat, lon);
    const near = networkIndex.nearest(x, z, 3000);
    if (near.i < 0) {
      $("map-hint").textContent = "No road near there. Click closer to a road.";
      return;
    }
    const xyz = network!.xyz;
    mapSel = { x: xyz[near.i * 3], z: xyz[near.i * 3 + 2], edge: near.edge, i: near.i };
    const edge = network!.edges[near.edge];
    $("map-hint").textContent = `${edge.ref ?? ""} ${edge.name ?? ""}`.trim() || "unnamed road";
    $<HTMLButtonElement>("map-ride-a").disabled = false;
    $<HTMLButtonElement>("map-ride-b").disabled = false;
    $("map-ride-a").textContent = `Ride ${directionLabel(near.edge, true)}`;
    $("map-ride-b").textContent = `Ride ${directionLabel(near.edge, false)}`;
    drawMap();
  });
  $("map-ride-a").onclick = () => startNetworkRide(true).catch(showError);
  $("map-ride-b").onclick = () => startNetworkRide(false).catch(showError);
  window.addEventListener("resize", () => screen === "map" && drawMap());
}

async function startNetworkRide(forward: boolean) {
  if (!mapSel) return;
  await endWorkout();
  await api.startOnNetwork(NETWORK_WORLD, mapSel.x, mapSel.z, forward);
  selectedRoute = NETWORK_WORLD;
  await buildWorld();
  // The tiles around the start stream in; hold the loading screen until the ground is there.
  if (world?.tiles) {
    $("loading-text").textContent = "Loading the terrain around you…";
    $("loading").hidden = false;
    world.update(latest ?? (await api.snapshot()));
    // Wait for the ground under the route's first point: that is where the rider stands.
    const start = (await api.route())?.points[0];
    const tiles = world.tiles;
    const ticker = setInterval(() => {
      $("loading-text").textContent = tiles.pending ? `Loading the terrain around you… ${tiles.pending} tile${tiles.pending === 1 ? "" : "s"} to go` : "Loading the terrain around you…";
    }, 300);
    await tiles.whenReady(start?.x ?? mapSel.x, start?.z ?? mapSel.z, 30000);
    clearInterval(ticker);
    $("loading").hidden = true;
  }
  await api.resetRide();
  stats.samples = stats.power = stats.hr = stats.hrSamples = 0;
  finishShown = false;
  show("ride");
}

const TURN_ARROWS: Record<Turn, string> = { sharp_left: "↰", left: "←", straight: "↑", right: "→", sharp_right: "↱", u_turn: "↶" };

function renderJunction(j: Junction | null, distance: number) {
  const box = $("hud-junction");
  box.hidden = !j;
  if (!j) {
    lastJunctionKey = "";
    return;
  }
  $("hud-junction-dist").textContent = `Junction in ${Math.max(0, Math.round(j.at_m - distance))} m`;
  const key = `${j.node}:${j.options.map((o) => `${o.edge}${o.chosen ? "*" : ""}`).join(",")}`;
  if (key === lastJunctionKey) return;
  lastJunctionKey = key;
  $("hud-junction-options").replaceChildren(
    ...j.options.map((o) => {
      const b = el("button", { className: o.chosen ? "on" : "" });
      b.append(el("span", { className: "arrow" }, TURN_ARROWS[o.turn]), el("span", { className: "road" }, o.ref ?? (o.to.length ? o.turn.replace("_", " ") : "side road")), el("span", { className: "to" }, o.to.join(" · ")));
      b.onclick = () => api.chooseTurn(o.edge).catch(showError);
      return b;
    }),
  );
}

/** Left or right arrow: the option next to the chosen one in that direction. */
function turnKey(dir: -1 | 1) {
  const j = latest?.junction;
  if (!j) return;
  const current = j.options.findIndex((o) => o.chosen);
  const next = j.options[Math.min(j.options.length - 1, Math.max(0, current + dir))];
  if (next && !next.chosen) api.chooseTurn(next.edge).catch(showError);
}

// --- routes and the world -----------------------------------------------------

function fillRouteList() {
  const island = el(
    "div",
    { className: "route-card" },
    el("b", {}, "Mallorca · Serra de Tramuntana"),
    el("button", { className: "primary", textContent: "Map" }),
    el("span", { className: "meta" }, "free ride · every road of the range, the Ma-10 included · pick your start on the map"),
  );
  island.onclick = () => openMap().catch(showError);
  $("route-list").replaceChildren(
    island,
    ...routes.map((r) => {
      const km = (r.length_m / 1000).toFixed(1);
      const card = el(
        "div",
        { className: `route-card${r.id === selectedRoute ? " selected" : ""}` },
        el("b", {}, r.name),
        el("button", { className: "primary", textContent: "Ride" }),
        el("span", { className: "meta" }, `${km} km · ${Math.round(r.climb_m)} m climbing · ${r.closed ? "loop" : "climb"}${r.world ? " · real terrain" : ""}`),
      );
      card.onclick = () => startRide(r.id).catch(showError);
      return card;
    }),
  );
}

/** Builds the 3D world for the engine's current route. */
async function buildWorld() {
  const loading = $("loading");
  loading.hidden = false;
  route = await api.route();
  if (!route) {
    loading.hidden = true;
    return;
  }
  $("loading-text").textContent = `Building ${route.name}…`;
  await new Promise((r) => setTimeout(r, 50));
  let terrain: WorldData | undefined;
  let networkView: NetworkView | undefined;
  $("attribution").textContent = "";
  if (route.world === NETWORK_WORLD) {
    if (!(await ensureNetwork())) return;
    $("attribution").textContent = networkWorld!.attribution;
    networkView = { data: networkWorld!, index: networkIndex! };
  } else if (route.world) {
    try {
      terrain = await loadWorld(route.world);
      $("attribution").textContent = terrain.attribution;
    } catch (e) {
      showError(`terrain for ${route.world} not loaded (${e}); riding a procedural world`);
    }
  }
  world?.dispose();
  world = new World($<HTMLCanvasElement>("world"), route, terrain, networkView ? { data: networkView.data, net: network! } : undefined);
  world.onFrame = () => hud?.frame();
  hud = new Hud(world.sampler, !!networkView);
  minimap = new Minimap($<HTMLCanvasElement>("minimap"), route, terrain, networkView);
  routeVersion = latest?.route_version ?? -1;
  hud.setWorkout(activeWorkout);
  applyProfile(screen === "rider" ? draft : profile);
  show(screen);
  loading.hidden = true;
}

async function startRide(id: string) {
  await endWorkout();
  if (id !== selectedRoute || !world) {
    await api.setRoute(id);
    selectedRoute = id;
    fillRouteList();
    await buildWorld();
  }
  // Building the world takes seconds and the trainer keeps going: the ride starts now.
  await api.resetRide();
  stats.samples = stats.power = stats.hr = stats.hrSamples = 0;
  finishShown = false;
  show("ride");
}

function onSnapshot(snap: EngineSnapshot) {
  renderDebug(snap);
  world?.update(snap);
  if (world && snap.route_version !== routeVersion && routeVersion >= 0) {
    // The navigator extended or re-planned the road ahead.
    routeVersion = snap.route_version;
    api
      .route()
      .then((r) => {
        if (r && world) {
          route = r;
          world.setRoute(r);
          hud?.setSampler(world.sampler);
          minimap?.setRoute(r);
        }
      })
      .catch(showError);
  }
  if (screen === "ride" || screen === "pause") {
    hud?.update(snap);
    minimap?.update(snap);
    renderJunction(snap.junction, snap.session.distance_m);
    const pending = world?.tiles?.pending ?? 0;
    $("hud-tiles").textContent = pending ? `· loading ${pending} tiles` : "";
    if (snap.session.power_w !== null) {
      stats.samples++;
      stats.power += snap.session.power_w;
    }
    if (snap.session.heart_rate_bpm !== null) {
      stats.hrSamples++;
      stats.hr += snap.session.heart_rate_bpm;
    }
    if ((snap.session.finished || snap.session.workout?.done) && !finishShown) {
      finishShown = true;
      showFinish(snap);
    }
  }
}

function showFinish(snap: EngineSnapshot) {
  const s = snap.session;
  const avgPower = stats.samples ? stats.power / stats.samples : null;
  const avgHr = stats.hrSamples ? stats.hr / stats.hrSamples : null;
  $("finish-title").textContent = activeWorkout ? `${profile.avatar} ${activeWorkout.name}: complete!` : `${profile.avatar} ${route?.name ?? "Ride"}: done!`;
  endWorkout().catch(showError);
  const item = (label: string, value: string) => [el("span", {}, label), el("b", {}, value)];
  $("finish-stats").replaceChildren(
    ...item("Time", duration(s.elapsed_s)),
    ...item("Distance", `${(s.distance_m / 1000).toFixed(2)} km`),
    ...item("Average power", avgPower === null ? "–" : `${num(avgPower)} W`),
    ...item("Average heart rate", avgHr === null ? "–" : `${num(avgHr)} bpm`),
    ...item("Average speed", s.elapsed_s > 0 ? `${((s.distance_m / s.elapsed_s) * 3.6).toFixed(1)} km/h` : "–"),
  );
  show("finish");
}

// --- wiring --------------------------------------------------------------------

function wire() {
  wireDebug();
  $("start-go").onclick = () => show("menu");
  $("menu-ride").onclick = () => startRide(selectedRoute || routes[0]?.id).catch(showError);
  $("menu-rider").onclick = () => show("rider");
  $("menu-settings").onclick = () => show("settings");
  $("menu-quit").onclick = () => api.quit().catch(showError);
  // Back buttons: delegated at the document, so they work whatever else happens to the panels.
  document.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.("[data-back]")) {
      e.preventDefault();
      back();
    }
  });
  $("pause-resume").onclick = () => show("ride");
  $("pause-end-workout").onclick = () => {
    endWorkout().catch(showError);
    show("ride");
  };
  $("menu-new-workout").onclick = () => openWorkout({ name: "", steps: [] }, -1);
  $("workout-save").onclick = saveWorkout;
  $("workout-start").onclick = () => startWorkout().catch(showError);
  $("workout-delete").onclick = () => {
    if (editingIndex >= 0) workouts.splice(editingIndex, 1);
    saveWorkouts(workouts);
    fillWorkoutList();
    show("menu");
  };
  $("workout-add").onclick = () => {
    const last = editing.steps[editing.steps.length - 1];
    editing.steps.push({ watts: last?.watts ?? Math.round(ftp * 0.6), seconds: last?.seconds ?? 300 });
    fillWorkoutEditor();
  };
  $<HTMLInputElement>("workout-name").oninput = () => (editing.name = $<HTMLInputElement>("workout-name").value);
  $<HTMLSelectElement>("workout-preset").onchange = () => {
    const i = Number($<HTMLSelectElement>("workout-preset").value);
    if (Number.isFinite(i) && PRESETS[i]) {
      const w = fromPreset(PRESETS[i], ftp);
      editing.name = w.name;
      editing.steps = w.steps;
      fillWorkoutEditor();
    }
  };
  $<HTMLInputElement>("workout-ftp").onchange = () => {
    ftp = Math.min(600, Math.max(50, Number($<HTMLInputElement>("workout-ftp").value) || 200));
    saveFtp(ftp);
    fillWorkoutEditor();
  };
  $("pause-restart").onclick = () => startRide(selectedRoute).catch(showError);
  $("pause-settings").onclick = () => show("settings");
  $("pause-menu").onclick = () => {
    endWorkout().catch(showError);
    show("menu");
  };
  $("finish-again").onclick = () => startRide(selectedRoute).catch(showError);
  $("finish-menu").onclick = () => show("menu");
  $("toggle-debug").onclick = toggleDebug;
  $("close-debug").onclick = toggleDebug;
  wireMap();
  const name = $<HTMLInputElement>("rider-name");
  name.oninput = () => {
    draft.name = name.value.slice(0, 24);
    previewDraft();
  };
  $("rider-save").onclick = saveDraft;

  window.addEventListener("keydown", (e) => {
    if (e.key === "F11") {
      e.preventDefault();
      api.toggleFullscreen().catch(showError);
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (e.key === "Escape") {
      if (!$("debug").hidden) toggleDebug();
      else if (screen === "ride") show("pause");
      else if (screen === "pause") show("ride");
      else if (screen === "rider" || screen === "settings") back();
      return;
    }
    if (screen === "start" && e.key === "Enter") {
      show("menu");
      return;
    }
    if (e.repeat) return;
    if (screen === "ride" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      turnKey(e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    const dir = shiftForKey(e.key);
    if (dir) {
      e.preventDefault();
      api.shift(dir);
      return;
    }
    if (e.key === "d" || e.key === "D") toggleDebug();
    else if ((e.key === "c" || e.key === "C") && world && screen === "ride") world.cycleCamera();
    else if (e.key === "a" || e.key === "A") api.setAutoShift(!(latest?.session.auto_shift ?? false)).catch(showError);
  });
}

function toggleDebug() {
  const drawer = $("debug");
  drawer.hidden = !drawer.hidden;
}

async function start() {
  if (!insideTauri()) {
    $("not-tauri").hidden = false;
    return;
  }
  wire();
  applyStoredDrivetrain();
  applyProfile(profile);
  const startup = await api.startupInfo();
  routes = await api.routes();
  selectedRoute = startup.route;
  fillRouteList();
  await api.onSnapshot(onSnapshot);
  onSnapshot(await api.snapshot());
  const wanted = startup.screen ?? (startup.start_m > 0 ? "ride" : "start");
  if (wanted === "workout") openWorkout(fromPreset(PRESETS[0], ftp), -1);
  else show((["start", "menu", "rider", "settings", "ride"] as Screen[]).includes(wanted as Screen) ? (wanted as Screen) : "start");
  await buildWorld();
  if (startup.camera && world) world.setCamera(startup.camera);
  scan().catch(showError);
  if (startup.screen === "island") {
    // For looking at the island: start at a given lat,lon (toward the edge's end unless ",back"), else on the Ma-10.
    if (await ensureNetwork()) {
      let forward = true;
      if (startup.island_at) {
        const [lat, lon, dir] = startup.island_at.split(",");
        const [x, z] = new Frame(networkWorld!.origin.lat, networkWorld!.origin.lon).toXZ(Number(lat), Number(lon));
        const near = networkIndex!.nearest(x, z, 5000);
        mapSel = { x: network!.xyz[near.i * 3], z: network!.xyz[near.i * 3 + 2], edge: near.edge, i: near.i };
        forward = dir !== "back";
      } else {
        const e = network!.edges.findIndex((x) => x.ref === "Ma-10" && x.count > 80);
        const p = network!.edges[e].start + 20;
        mapSel = { x: network!.xyz[p * 3], z: network!.xyz[p * 3 + 2], edge: e, i: p };
      }
      await startNetworkRide(forward);
      if (startup.camera && world) world.setCamera(startup.camera);
    }
  } else if (startup.screen === "map") {
    await openMap();
  }
  if (startup.screen === "workout-ride") {
    // For looking at the workout HUD: ride the first preset on the flat road.
    openWorkout(fromPreset(PRESETS[0], ftp), -1);
    $<HTMLSelectElement>("workout-route").value = "flat";
    await startWorkout();
  }
}

start().catch(showError);
