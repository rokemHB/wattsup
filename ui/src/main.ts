// The app's screens: start, main menu, rider, settings, the ride with its HUD
// and minimap, pause and finish. The 3D world runs behind all of them.
import { api, insideTauri } from "./api";
import { latest, renderDebug, scan, showError, wireDebug } from "./debug";
import { $, el } from "./dom";
import { duration, isTypingTarget, num, shiftForKey } from "./format";
import { drawWorkout, Hud } from "./hud";
import { Minimap } from "./minimap";
import { ACCENTS, AVATARS, BIKES, JERSEYS, loadProfile, type Profile, saveProfile } from "./profile";
import type { EngineSnapshot, Route, RouteInfo, Workout } from "./types";
import { describe, fromPreset, loadFtp, loadWorkouts, PRESETS, saveFtp, saveWorkouts, validStep } from "./workouts";
import { loadWorld, type WorldData } from "./world/terrain";
import { World } from "./world/world";

type Screen = "start" | "menu" | "rider" | "settings" | "workout" | "ride" | "pause" | "finish";

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
const stats = { samples: 0, power: 0, hr: 0, hrSamples: 0 };

// --- screens -----------------------------------------------------------------

function show(next: Screen) {
  if (next === "settings" || next === "rider" || next === "workout") cameFrom = screen === "pause" ? "pause" : "menu";
  if (next === "rider") draft = { ...profile };
  screen = next;
  for (const s of ["start", "menu", "rider", "settings", "workout", "pause", "finish"]) $(`screen-${s}`).hidden = s !== next;
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

// --- routes and the world -----------------------------------------------------

function fillRouteList() {
  $("route-list").replaceChildren(
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
  $("attribution").textContent = "";
  if (route.world) {
    try {
      terrain = await loadWorld(route.world);
      $("attribution").textContent = terrain.attribution;
    } catch (e) {
      showError(`terrain for ${route.world} not loaded (${e}); riding a procedural world`);
    }
  }
  world?.dispose();
  world = new World($<HTMLCanvasElement>("world"), route, terrain);
  world.onFrame = () => hud?.frame();
  hud = new Hud(world.sampler);
  minimap = new Minimap($<HTMLCanvasElement>("minimap"), route, terrain);
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
  } else {
    await api.resetRide();
  }
  stats.samples = stats.power = stats.hr = stats.hrSamples = 0;
  finishShown = false;
  show("ride");
}

function onSnapshot(snap: EngineSnapshot) {
  renderDebug(snap);
  world?.update(snap);
  if (screen === "ride" || screen === "pause") {
    hud?.update(snap);
    minimap?.update(snap);
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
  if (startup.screen === "workout-ride") {
    // For looking at the workout HUD: ride the first preset on the flat road.
    openWorkout(fromPreset(PRESETS[0], ftp), -1);
    $<HTMLSelectElement>("workout-route").value = "flat";
    await startWorkout();
  }
}

start().catch(showError);
