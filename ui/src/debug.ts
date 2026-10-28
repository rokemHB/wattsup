// The debug drawer and the device panel: live engine values, gearing, mode,
// the device slots with scanning, and the log.
import { api } from "./api";
import { $, el } from "./dom";
import { describeCommand, distance, duration, KIND_LABEL, num, stateLabel } from "./format";
import type { ControllerButton, DeviceKind, DeviceStatus, DiscoveredDevice, EngineSnapshot, ScanResult } from "./types";

const COG_TEETH = 14;

let lastSlotsJson = "";
let lastLogSeq = 0;
let lastGearKey = "";
let lastScan: ScanResult = { devices: [], errors: [] };
export let latest: EngineSnapshot | null = null;

// --- remembered devices: the real device last used in each role connects by itself after a scan.
const DEVICES_KEY = "wattsup.devices";
type Remembered = Partial<Record<DeviceKind, { id: string; name: string }>>;

function loadRemembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(DEVICES_KEY) ?? "{}") as Remembered;
  } catch {
    return {};
  }
}

function saveRemembered(r: Remembered) {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(r));
  } catch {
    // storage may be unavailable
  }
  renderRemembered();
}

/** Keeps a device the user chose for a role (simulated ones are not kept: they would ride by themselves). */
function rememberDevice(kind: DeviceKind, d: DiscoveredDevice) {
  if (d.simulated) return;
  saveRemembered({ ...loadRemembered(), [kind]: { id: d.id, name: d.name } });
}

function forgetDevice(kind: DeviceKind) {
  const r = loadRemembered();
  delete r[kind];
  saveRemembered(r);
}

function renderRemembered() {
  const r = loadRemembered();
  const kinds = (Object.keys(r) as DeviceKind[]).filter((k) => r[k]);
  $("device-memory").replaceChildren(
    ...kinds.map((kind) =>
      el(
        "div",
        { className: "slot" },
        el("span", { className: "role" }, `${KIND_LABEL[kind]} · remembered`),
        el("span", { className: "name" }, `${r[kind]!.name} · connects by itself after a scan`),
        el(
          "span",
          { className: "row" },
          el("button", { className: "small", textContent: "Connect", onclick: () => scan(true).catch(showError) }),
          el("button", { className: "small", textContent: "Forget", onclick: () => forgetDevice(kind) }),
        ),
      ),
    ),
  );
}

/** Connects the remembered devices the last scan found, where the role is still empty. */
async function connectRemembered() {
  const r = loadRemembered();
  for (const kind of Object.keys(r) as DeviceKind[]) {
    const want = r[kind];
    const slot = latest?.devices.find((d) => d.kind === kind);
    if (!want || (slot && slot.state.state !== "disconnected")) continue;
    if (!lastScan.devices.some((d) => d.id === want.id && d.kinds.includes(kind))) continue;
    await api.connect(want.id, kind).catch(showError);
  }
}

export function showError(e: unknown) {
  $("scan-status").textContent = String(e);
}

/** Updates the debug drawer and the device panel from a snapshot. */
export function renderDebug(snap: EngineSnapshot) {
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
  for (const id of ["auto-shift", "settings-auto-shift"]) $<HTMLInputElement>(id).checked = s.auto_shift;
  $<HTMLInputElement>("settings-virtual-gearing").checked = s.virtual_gearing;
  // Without virtual gears there is no gear to show and nothing to auto-shift.
  document.body.classList.toggle("no-gears", !s.virtual_gearing);
  for (const id of ["target-cadence", "settings-target-cadence"]) {
    const target = $<HTMLInputElement>(id);
    if (document.activeElement !== target) target.value = String(s.target_cadence_rpm);
  }

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
  // The menu shows a one-line summary.
  const connected = devices.filter((d) => d.state.state === "connected").map((d) => KIND_LABEL[d.kind].toLowerCase());
  $("menu-devices").textContent = connected.length ? `Connected: ${connected.join(", ")}` : "No devices connected";
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

function renderScan() {
  const showSim = $<HTMLInputElement>("show-sim").checked;
  const devices = lastScan.devices.filter((d) => showSim || !d.simulated);
  $("scan-results").replaceChildren(...lastScan.errors.map((e) => el("div", { className: "warning" }, e)), ...devices.map(renderFound));
}

function renderFound(d: DiscoveredDevice) {
  const buttons = d.kinds.map((kind: DeviceKind) =>
    el("button", {
      className: "small",
      textContent: `Use as ${KIND_LABEL[kind].toLowerCase()}`,
      onclick: () =>
        api
          .connect(d.id, kind)
          .then(() => rememberDevice(kind, d))
          .catch(showError),
    }),
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

/** Applies the stored drivetrain choice at startup. */
export function applyStoredDrivetrain() {
  try {
    if (localStorage.getItem("wattsup.virtualGearing") === "0") api.setVirtualGearing(false).catch(showError);
  } catch {
    // storage may be unavailable
  }
}

/** Scans for devices; with `reconnect`, the remembered ones then connect by themselves. */
export async function scan(reconnect = false) {
  const button = $<HTMLButtonElement>("scan");
  button.disabled = true;
  $("scan-status").textContent = "scanning…";
  try {
    lastScan = await api.scan(5);
    $("scan-status").textContent = `${lastScan.devices.length} found`;
    renderScan();
    if (reconnect) await connectRemembered();
  } catch (e) {
    showError(e);
  } finally {
    button.disabled = false;
  }
}

/** Hooks up the debug drawer's and the device panel's controls. */
export function wireDebug() {
  $("shift-up").onclick = () => api.shift("up");
  $("shift-down").onclick = () => api.shift("down");
  $("mode-sim").onclick = () => api.setMode("sim");
  $("mode-erg").onclick = () => api.setMode("erg");
  $("scan").onclick = () => scan(true).catch(showError);
  $("show-sim").onchange = renderScan;
  renderRemembered();

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

  for (const id of ["auto-shift", "settings-auto-shift"]) {
    const auto = $<HTMLInputElement>(id);
    auto.onchange = () => api.setAutoShift(auto.checked).catch(showError);
  }
  const gearing = $<HTMLInputElement>("settings-virtual-gearing");
  gearing.onchange = () => {
    try {
      localStorage.setItem("wattsup.virtualGearing", gearing.checked ? "1" : "0");
    } catch {
      // storage may be unavailable
    }
    api.setVirtualGearing(gearing.checked).catch(showError);
  };
  for (const id of ["target-cadence", "settings-target-cadence"]) {
    const target = $<HTMLInputElement>(id);
    target.onchange = () => api.setTargetCadence(Number(target.value)).catch(showError);
  }
}
