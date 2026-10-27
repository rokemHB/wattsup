// The app's screens: start, main menu, rider, settings, the ride with its HUD
// and minimap, pause and finish. The 3D world runs behind all of them.
import { api, insideTauri } from "./api";
import { latest, renderDebug, scan, showError, wireDebug } from "./debug";
import { $, el } from "./dom";
import { duration, isTypingTarget, num, shiftForKey } from "./format";
import { Hud } from "./hud";
import { Minimap } from "./minimap";
import { ACCENTS, AVATARS, BIKES, JERSEYS, loadProfile, type Profile, saveProfile } from "./profile";
import type { EngineSnapshot, Route, RouteInfo } from "./types";
import { loadWorld, type WorldData } from "./world/terrain";
import { World } from "./world/world";

type Screen = "start" | "menu" | "rider" | "settings" | "ride" | "pause" | "finish";

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
const stats = { samples: 0, power: 0, hr: 0, hrSamples: 0 };

// --- screens -----------------------------------------------------------------

function show(next: Screen) {
  if (next === "settings" || next === "rider") cameFrom = screen === "pause" ? "pause" : "menu";
  if (next === "rider") draft = { ...profile };
  screen = next;
  for (const s of ["start", "menu", "rider", "settings", "pause", "finish"]) $(`screen-${s}`).hidden = s !== next;
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
  applyProfile(screen === "rider" ? draft : profile);
  show(screen);
  loading.hidden = true;
}

async function startRide(id: string) {
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
    if (snap.session.finished && !finishShown) {
      finishShown = true;
      showFinish(snap);
    }
  }
}

function showFinish(snap: EngineSnapshot) {
  const s = snap.session;
  const avgPower = stats.samples ? stats.power / stats.samples : null;
  const avgHr = stats.hrSamples ? stats.hr / stats.hrSamples : null;
  $("finish-title").textContent = `${profile.avatar} ${route?.name ?? "Ride"}: done!`;
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
  document.querySelectorAll<HTMLButtonElement>("[data-back]").forEach((b) => (b.onclick = back));
  $("pause-resume").onclick = () => show("ride");
  $("pause-restart").onclick = () => startRide(selectedRoute).catch(showError);
  $("pause-settings").onclick = () => show("settings");
  $("pause-menu").onclick = () => show("menu");
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
  show((["start", "menu", "rider", "settings", "ride"] as Screen[]).includes(wanted as Screen) ? (wanted as Screen) : "start");
  await buildWorld();
  if (startup.camera && world) world.setCamera(startup.camera);
  scan().catch(showError);
}

start().catch(showError);
