// The app's screens: start, main menu, rider, settings, the ride with its HUD
// and minimap, pause and finish. The 3D world runs behind all of them.
import { api, insideTauri } from "./api";
import { applyStoredDrivetrain, latest, renderDebug, scan, showError, wireDebug } from "./debug";
import { $, el } from "./dom";
import { duration, isTypingTarget, num, shiftForKey } from "./format";
import { drawWorkout, Hud } from "./hud";
import { loadPlans, MapScreen, type RoadSpot, type SavedPlan } from "./map";
import { Minimap, type NetworkView } from "./minimap";
import { ACCENTS, AVATARS, BIKES, JERSEYS, loadProfile, type Profile, saveProfile } from "./profile";
import type { PlannedPath } from "./routing";
import type { EngineSnapshot, Junction, Route, RouteInfo, Turn, Workout } from "./types";
import { loadNetwork, NetworkIndex, type RoadNetwork } from "./world/network";
import { Frame, prefetchWorld, worldDownloadEstimate } from "./world/streaming";
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
  if (next === "map") mapScreen.scheduleDraw();
  if (next === "pause") $("pause-end-workout").hidden = !activeWorkout;
  if (next === "menu") fillWorkoutList();
  $("hud").hidden = !(next === "ride" || next === "pause" || next === "finish");
  if (next === "rider") fillRiderScreen();
  world?.setCamera(next === "ride" || next === "pause" || next === "finish" ? "chase" : "orbit");
  world?.setIdle(next !== "ride");
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

/** The planned ride about to start: the HUD shows its whole profile, not a window. */
let plannedRide = false;

const mapScreen = new MapScreen({
  freeRide: (at, forward) => startNetworkRide(at, forward).catch(showError),
  plannedRide: (path, name, start) => startPlannedRide(path, name, start).catch(showError),
});
mapScreen.onPlansChanged = () => fillRouteList();

async function ensureNetwork(): Promise<boolean> {
  if (network && networkWorld) return true;
  try {
    const [net, data] = await Promise.all([loadNetwork(NETWORK_WORLD), loadNetworkWorld(NETWORK_WORLD)]);
    if (!net) return false;
    network = net;
    networkIndex = new NetworkIndex(net);
    networkWorld = data;
    return true;
  } catch (e) {
    showError(`island not available: ${e}`);
    return false;
  }
}

async function openMap(plan?: SavedPlan) {
  $("loading-text").textContent = "Loading the island…";
  $("loading").hidden = false;
  const ok = await ensureNetwork();
  $("loading").hidden = true;
  if (!ok) return;
  $("map-title").textContent = networkWorld!.name;
  mapScreen.open(network!, networkIndex!, networkWorld!);
  if (!downloading) {
    const est = worldDownloadEstimate(network!, networkWorld!);
    $("map-download-text").textContent = `Terrain streams in as you ride and is kept on disk. The whole region is about ${Math.round(est.bytes / 1e6)} MB (${est.files} files).`;
  }
  show("map");
  if (plan) mapScreen.load(plan);
}

let downloading: { cancelled: boolean } | null = null;

/** Fetches the whole region's terrain into the disk cache, with progress on the map screen; a second click cancels. */
async function downloadTerrain() {
  if (!network || !networkWorld) return;
  const button = $<HTMLButtonElement>("map-download");
  const bar = $<HTMLProgressElement>("map-download-bar");
  const text = $("map-download-text");
  if (downloading) {
    downloading.cancelled = true;
    return;
  }
  downloading = { cancelled: false };
  button.textContent = "Cancel";
  bar.hidden = false;
  bar.value = 0;
  const mb = (b: number) => (b / 1e6).toFixed(0);
  const failed = await prefetchWorld(network, networkWorld, (done, total, bytes) => {
    bar.value = done / total;
    text.textContent = `Downloading terrain: ${done} of ${total} files, ${mb(bytes)} MB so far.`;
  }, downloading);
  const cancelled = downloading.cancelled;
  downloading = null;
  button.textContent = "Download all terrain";
  bar.hidden = true;
  text.textContent = cancelled ? "Download stopped. Click again to continue; what is already here stays." : failed ? `Done, but ${failed} files could not be fetched. Click again to retry them.` : "All terrain is on disk. Rides in this region work offline now.";
}

/** A free ride from a road point, toward the edge's end if `forward`. */
async function startNetworkRide(at: RoadSpot, forward: boolean) {
  await endWorkout();
  plannedRide = false;
  await api.startOnNetwork(NETWORK_WORLD, at.x, at.z, forward);
  await beginNetworkRide(at);
}

/** A ride along a route planned on the map. */
async function startPlannedRide(path: PlannedPath, name: string, start: RoadSpot) {
  await endWorkout();
  plannedRide = true;
  await api.startPlannedRide(NETWORK_WORLD, name, path.legs);
  await beginNetworkRide(start);
}

async function beginNetworkRide(at: { x: number; z: number }) {
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
    await tiles.whenReady(start?.x ?? at.x, start?.z ?? at.z, 30000);
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
    el("span", { className: "meta" }, "plan a route on the map or ride free · every road of the range, the Ma-10 included"),
  );
  island.onclick = () => openMap().catch(showError);
  const plans = loadPlans()
    .filter((p) => p.world === NETWORK_WORLD)
    .map((p) => {
      const card = el("div", { className: "route-card" }, el("b", {}, p.name), el("button", { className: "primary", textContent: "Map" }), el("span", { className: "meta" }, `${(p.length_m / 1000).toFixed(1)} km · planned on the map`));
      card.onclick = () => openMap(p).catch(showError);
      return card;
    });
  $("route-list").replaceChildren(
    island,
    ...plans,
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
  hud = new Hud(world.sampler, !!networkView && !plannedRide);
  minimap = new Minimap($<HTMLCanvasElement>("minimap"), route, terrain, networkView);
  routeVersion = latest?.route_version ?? -1;
  hud.setWorkout(activeWorkout);
  applyProfile(screen === "rider" ? draft : profile);
  show(screen);
  loading.hidden = true;
}

async function startRide(id: string) {
  await endWorkout();
  plannedRide = false;
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
  $("map-download").onclick = () => downloadTerrain().catch(showError);
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
      else if (screen === "map" && mapScreen.escape()) return;
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
      let at: RoadSpot;
      if (startup.island_at) {
        const [lat, lon, dir] = startup.island_at.split(",");
        const [x, z] = new Frame(networkWorld!.origin.lat, networkWorld!.origin.lon).toXZ(Number(lat), Number(lon));
        const near = networkIndex!.nearest(x, z, 5000);
        at = { x: network!.xyz[near.i * 3], z: network!.xyz[near.i * 3 + 2], edge: near.edge, i: near.i };
        forward = dir !== "back";
      } else {
        const e = network!.edges.findIndex((x) => x.ref === "Ma-10" && x.count > 80);
        const p = network!.edges[e].start + 20;
        at = { x: network!.xyz[p * 3], z: network!.xyz[p * 3 + 2], edge: e, i: p };
      }
      await startNetworkRide(at, forward);
      if (startup.camera && world) world.setCamera(startup.camera);
    }
  } else if (startup.screen === "map" || startup.screen === "map-download") {
    await openMap();
    // For testing the download: start it right away.
    if (startup.screen === "map-download") downloadTerrain().catch(showError);
    // For looking at the planner: WATTSUP_ISLAND_AT="lat,lon;lat,lon[;…]" plans a route through those points.
    if (startup.island_at?.includes(";")) mapScreen.planThrough(startup.island_at.split(";").map((p) => p.split(",").map(Number) as [number, number]));
  }
  if (startup.dev_js) {
    // Test driving: WATTSUP_DEV_JS runs with `wattsup.map` (the map screen), `wattsup.api` and `wattsup.screen()` in scope.
    Object.assign(window, { wattsup: { map: mapScreen, api, screen: () => screen } });
    new Function(startup.dev_js)();
  }
  if (startup.screen === "workout-ride") {
    // For looking at the workout HUD: ride the first preset on the flat road.
    openWorkout(fromPreset(PRESETS[0], ftp), -1);
    $<HTMLSelectElement>("workout-route").value = "flat";
    await startWorkout();
  }
}

start().catch(showError);
