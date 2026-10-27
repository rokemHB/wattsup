// The milestone-1 debug screen: live values, gearing, mode, devices, log.
import { api, insideTauri } from "./api";
import { describeCommand, distance, duration, isTypingTarget, KIND_LABEL, num, shiftForKey, stateLabel } from "./format";
import { Hud } from "./hud";
import type { ControllerButton, DeviceKind, DeviceStatus, DiscoveredDevice, EngineSnapshot, ScanResult } from "./types";
import { World } from "./world/world";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const COG_TEETH = 14;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function showError(e: unknown) {
  $("scan-status").textContent = String(e);
}

// --- live values -------------------------------------------------------------

let lastSlotsJson = "";
let lastLogSeq = 0;
let lastGearKey = "";
let latest: EngineSnapshot | null = null;

function render(snap: EngineSnapshot) {
  latest = snap;
  const s = snap.session;
  $("elapsed").textContent = duration(s.elapsed_s);
  $("distance").textContent = distance(s.distance_m);
  $("power").textContent = num(s.power_w);
  $("power-model").textContent = `W · model ${num(s.model_power_w)} W`;
  $("cadence").textContent = num(s.cadence_rpm);
  $("speed").textContent = num(s.virtual_speed_kmh, 1);
  $("hr").textContent = num(s.heart_rate_bpm);
  $("gear").textContent = String(s.gear);
  $("gear-ratio").textContent = `of ${s.gear_count} · ratio ${s.gear_ratio.toFixed(2)}`;
  $("trainer-speed").textContent = num(s.trainer_speed_kmh, 1);
  $("road-grade").textContent = s.road_grade_pct.toFixed(1);

  const sent = describeCommand(s.last_command);
  $("sent").textContent = sent.text;
  $("sent-age").textContent = s.last_command_age_s === null ? "" : `${s.last_command_age_s.toFixed(1)} s ago`;
  const warning = $("sent-warning");
  warning.hidden = !sent.warning;
  warning.textContent = sent.warning ?? "";

  $("drive-ratio").textContent = num(s.measured_drive_ratio, 2);
  $("drive-teeth").textContent =
    s.measured_drive_ratio === null ? "pedal to measure" : `≈ ${Math.round(s.measured_drive_ratio * COG_TEETH)}T over a ${COG_TEETH}T Cog`;

  $("mode-sim").classList.toggle("on", s.mode === "sim");
  $("mode-erg").classList.toggle("on", s.mode === "erg");
  const erg = $<HTMLInputElement>("erg-target");
  if (document.activeElement !== erg) erg.value = String(s.erg_target_w);

  renderGears(s.gear, s.gear_count);
  renderProviders(snap.providers);
  renderSlots(snap.devices);
  renderLog(snap);
}

function renderGears(gear: number, count: number) {
  const key = `${gear}/${count}`;
  if (key === lastGearKey) return;
  lastGearKey = key;
  const strip = $("gear-strip");
  strip.replaceChildren(
    ...Array.from({ length: count }, (_, i) => {
      const bar = el("div", { className: i + 1 === gear ? "active" : i + 1 < gear ? "below" : "", title: `gear ${i + 1}` });
      bar.style.height = `${30 + (70 * (i + 1)) / count}%`;
      return bar;
    }),
  );
}

function renderProviders(providers: string[]) {
  const box = $("providers");
  const text = providers.join(",");
  if (box.dataset.p === text) return;
  box.dataset.p = text;
  box.replaceChildren(...providers.map((p) => el("span", { className: "badge" }, p === "ble" ? "Bluetooth" : p === "sim" ? "Simulator" : p)));
}

function renderSlots(devices: DeviceStatus[]) {
  const json = JSON.stringify(devices);
  if (json === lastSlotsJson) return;
  lastSlotsJson = json;
  $("device-slots").replaceChildren(
    ...devices.map((d) => {
      const st = stateLabel(d.state);
      const battery = d.battery_percent === null ? "" : ` · battery ${d.battery_percent} %`;
      const action =
        d.state.state === "disconnected"
          ? el("span")
          : el("button", { className: "small", textContent: "Disconnect", onclick: () => api.disconnect(d.kind).catch(showError) });
      return el(
        "div",
        { className: "slot" },
        el("span", { className: "role" }, KIND_LABEL[d.kind]),
        el("span", { className: "name" }, (d.name ?? d.id ?? "–") + battery),
        el("span", { className: `state tone-${st.tone}` }, st.label),
        action,
      );
    }),
  );
  const controller = devices.find((d) => d.kind === "controller");
  $("sim-click-row").hidden = !(controller?.id?.startsWith("sim:") && controller.state.state === "connected");
}

function renderLog(snap: EngineSnapshot) {
  const list = $("log");
  const fresh = snap.log.filter((l) => l.seq > lastLogSeq);
  if (!fresh.length) return;
  lastLogSeq = fresh[fresh.length - 1].seq;
  for (const line of fresh) {
    list.append(el("li", {}, el("span", {}, `${duration(line.elapsed_s)} ${line.source}`), line.message));
  }
  while (list.children.length > 200) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

// --- scanning ----------------------------------------------------------------

let lastScan: ScanResult = { devices: [], errors: [] };

function renderScan() {
  const showSim = $<HTMLInputElement>("show-sim").checked;
  const devices = lastScan.devices.filter((d) => showSim || !d.simulated);
  $("scan-results").replaceChildren(
    ...lastScan.errors.map((e) => el("div", { className: "warning" }, e)),
    ...devices.map(renderFound),
  );
}

function renderFound(d: DiscoveredDevice) {
  const buttons = d.kinds.map((kind: DeviceKind) =>
    el("button", { className: "small", textContent: `Use as ${KIND_LABEL[kind].toLowerCase()}`, onclick: () => api.connect(d.id, kind).catch(showError) }),
  );
  const rssi = d.rssi === null ? "" : `${d.rssi} dBm`;
  return el(
    "div",
    { className: "found" },
    el("div", { className: "title" }, el("strong", {}, d.name), el("span", { className: "hint" }, rssi)),
    el("div", { className: "id" }, d.id),
    el("div", { className: "row" }, ...buttons),
  );
}

async function scan() {
  const button = $<HTMLButtonElement>("scan");
  button.disabled = true;
  $("scan-status").textContent = "scanning…";
  try {
    lastScan = await api.scan(5);
    $("scan-status").textContent = `${lastScan.devices.length} found`;
    renderScan();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

// --- wiring ------------------------------------------------------------------

function wire() {
  $("shift-up").onclick = () => api.shift("up");
  $("shift-down").onclick = () => api.shift("down");
  $("mode-sim").onclick = () => api.setMode("sim");
  $("mode-erg").onclick = () => api.setMode("erg");
  $("scan").onclick = scan;
  $("show-sim").onchange = renderScan;

  const erg = $<HTMLInputElement>("erg-target");
  erg.onchange = () => api.setErgTarget(Number(erg.value));
  document.querySelectorAll<HTMLButtonElement>("[data-erg]").forEach((b) => {
    b.onclick = () => api.setErgTarget((latest?.session.erg_target_w ?? Number(erg.value)) + Number(b.dataset.erg));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-press]").forEach((b) => {
    b.onclick = () => api.pressButton(b.dataset.press as ControllerButton).catch(showError);
  });

  const grade = $<HTMLInputElement>("grade");
  grade.oninput = () => api.setRoadGrade(Number(grade.value));

  $("toggle-debug").onclick = toggleDebug;
  $("close-debug").onclick = toggleDebug;

  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target) || e.repeat) return;
    const dir = shiftForKey(e.key);
    if (dir) {
      e.preventDefault();
      api.shift(dir);
      return;
    }
    if (e.key === "d" || e.key === "D") toggleDebug();
    else if ((e.key === "c" || e.key === "C") && world) world.cycleCamera();
    else if (e.key === "F11") {
      e.preventDefault();
      api.toggleFullscreen().catch(showError);
    } else if (e.key === "Escape" && !$("debug").hidden) toggleDebug();
  });
}

let world: World | null = null;
let hud: Hud | null = null;

function toggleDebug() {
  const drawer = $("debug");
  drawer.hidden = !drawer.hidden;
}

async function startWorld() {
  const route = await api.route();
  if (!route) return;
  world = new World($<HTMLCanvasElement>("world"), route);
  hud = new Hud(world.sampler);
  $("hud").hidden = false;
  $("grade").hidden = true;
  $("grade-hint").hidden = false;
}

async function start() {
  if (!insideTauri()) {
    $("not-tauri").hidden = false;
    return;
  }
  wire();
  await startWorld();
  const onSnap = (snap: EngineSnapshot) => {
    render(snap);
    world?.update(snap);
    hud?.update(snap);
  };
  await api.onSnapshot(onSnap);
  onSnap(await api.snapshot());
  await scan();
}

start().catch(showError);
