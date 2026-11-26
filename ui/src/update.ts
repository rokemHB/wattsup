// The version in Settings and "WattsUp x.y.z is out" in the main menu, from one request to GitHub
// at startup (update.rs), unless the rider turned that off. Nothing is downloaded: the notice
// opens the release page in the browser.
import { getVersion } from "@tauri-apps/api/app";
import { api, insideTauri } from "./api";
import { $ } from "./dom";

const KEY = "wattsup.updateCheck";

function checking(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function setChecking(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // The choice then holds for this session only.
  }
}

export function wireUpdate() {
  const box = $<HTMLInputElement>("settings-update-check");
  box.checked = checking();
  box.onchange = () => setChecking(box.checked);
  if (!insideTauri()) return;
  getVersion()
    .then((v) => ($("settings-version").textContent = v))
    .catch(() => {});
  if (!checking()) return;
  api
    .checkUpdate()
    .then((info) => {
      if (!info.newer || !info.url) return;
      const url = info.url;
      const notice = $<HTMLButtonElement>("menu-update");
      notice.textContent = `WattsUp ${info.newer} is out · Download`;
      notice.title = url;
      notice.onclick = () => api.openReleasePage(url).catch((e) => console.warn("open release page:", e));
      notice.hidden = false;
    })
    // Offline, or GitHub unreachable: no notice.
    .catch((e) => console.warn("update check:", e));
}
