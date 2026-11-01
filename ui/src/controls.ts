// What the controller's buttons do beyond shifting. The shift buttons and paddles shift by
// themselves (the engine); the face buttons and the left puck's nav buttons do what the
// rider picks here. A Click v2's right puck needs no Zwift unlock and keeps sending, so by
// default it carries the full set: its paddle harder, Z easier, Y and A the turns at a
// junction, B automatic shifting. The left puck's buttons work too while it sends.

export type Action = "none" | "shift_up" | "shift_down" | "turn_left" | "turn_right" | "u_turn" | "auto_shift" | "camera";

export const ACTIONS: { id: Action; label: string }[] = [
  { id: "none", label: "Nothing" },
  { id: "shift_up", label: "Shift harder" },
  { id: "shift_down", label: "Shift easier" },
  { id: "turn_left", label: "Turn left (junction)" },
  { id: "turn_right", label: "Turn right (junction)" },
  { id: "u_turn", label: "Turn around" },
  { id: "auto_shift", label: "Automatic shifting on/off" },
  { id: "camera", label: "Change camera" },
];

/** The assignable buttons, as the engine names them, with where they are. */
export const BUTTONS: { id: string; label: string }[] = [
  { id: "z", label: "Right puck · Z" },
  { id: "y", label: "Right puck · Y" },
  { id: "a", label: "Right puck · A" },
  { id: "b", label: "Right puck · B" },
  { id: "nav_left", label: "Left puck · left" },
  { id: "nav_right", label: "Left puck · right" },
  { id: "nav_up", label: "Left puck · up" },
  { id: "nav_down", label: "Left puck · down" },
];

const DEFAULTS: Record<string, Action> = {
  z: "shift_down",
  y: "turn_left",
  a: "turn_right",
  b: "auto_shift",
  nav_left: "turn_left",
  nav_right: "turn_right",
  nav_up: "u_turn",
  nav_down: "camera",
};

const KEY = "wattsup.buttons";

export function loadMapping(): Record<string, Action> {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Action>;
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveMapping(m: Record<string, Action>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // storage may be unavailable
  }
}

/** The settings rows: a select per button; `onChange` gets the new mapping. */
export function mappingRows(onChange: (m: Record<string, Action>) => void): HTMLElement[] {
  const m = loadMapping();
  return BUTTONS.map((b) => {
    const select = document.createElement("select");
    for (const a of ACTIONS) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.label;
      o.selected = m[b.id] === a.id;
      select.append(o);
    }
    select.onchange = () => {
      m[b.id] = select.value as Action;
      saveMapping(m);
      onChange({ ...m });
    };
    const row = document.createElement("label");
    row.className = "field";
    const name = document.createElement("span");
    name.textContent = b.label;
    row.append(name, select);
    return row;
  });
}
