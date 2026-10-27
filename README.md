# WattsUp

A gamified indoor cycling app for smart trainers. Bluetooth FTMS, heart rate
and virtual shifting on Linux, Windows and macOS. Zwift Cog support without a
paid subscription. You might even fly.

**Status: milestone 1, the foundation.** The device layer, the virtual gearbox
and a debug screen work; there is no game yet. See [HARDWARE_TESTING.md](HARDWARE_TESTING.md)
for checking it against real hardware.

## What it does

- Connects to a Bluetooth smart trainer (FTMS), a heart-rate strap (HRS) and a
  Zwift Click / Click v2 / Play / Ride controller. Keyboard shifting always
  works as a fallback.
- Gives a single-speed setup like the Zwift Cog 24 virtual gears, ratio 0.9 to
  5.0 in equal percentage steps, by steering the trainer's resistance.
- Simulates a rider on a virtual road (gravity, rolling resistance, aero) and
  reports virtual speed and distance.
- Runs an ERG mode (fixed target power) for workouts later.
- Comes with simulated devices, so everything can be developed and tested
  without a trainer.

## How virtual gearing works

The trainer only knows its real drive: your chainring over the 14-tooth Cog.
For each tick WattsUp computes the force the virtual bike would need at the
wheel (virtual speed from cadence × virtual gear ratio, plus road grade), scales
it by `virtual ratio / trainer ratio` so the pedal torque comes out the same,
and converts that force into a grade for the trainer's own simulation model.
That grade is sent as an FTMS *Set Indoor Bike Simulation* command (opcode
`0x11`), clamped to the trainer's range (-10 % to +20 % on a KICKR) and flagged
when clamped.

Why SIM mode and not ERG: in SIM mode the trainer's fast internal loop keeps
the resistance right through every pedal stroke and reacts to a shift at once.
ERG would have to chase a new target power after every cadence change, which
feels sluggish and fights shifting. ERG stays a separate mode for workouts.

Commands go out at once after a shift, a mode change or a grade change, and
otherwise at most every 250 ms, only when the grade moved by more than 0.1 %,
with a resend every 5 s in case a write was lost.

The gear maths relies on three guesses about the trainer that only hardware
can confirm (its assumed rider mass, whether `cw = 0` disables its own aero,
and the real chainring). The hardware checklist has a calibration step for
each; the measured drive ratio and the model power are shown live for it.

## Architecture

```
crates/core      pure logic, no I/O: physics, gearing, resistance mapping,
                 ride session (SIM/ERG, rate limiting), FTMS / HRS / Zwift codecs
crates/devices   Trainer / HeartRateMonitor / Controller traits, DeviceProvider,
                 one DeviceEvent channel; sim/ (rider model, HR, injectable
                 controller) and ble/ (btleplug: FTMS trainer, HRS strap,
                 Zwift controllers, shared reconnect runner, raw hex logging)
crates/engine    UI-independent orchestrator: scans all providers, fills the
                 three role slots, runs the event and tick loops, publishes an
                 EngineSnapshot on a watch channel
crates/cli       wattsup-cli: scan and ride from a terminal, for hardware checks
src-tauri        Tauri v2 shell: commands plus "snapshot" events
ui/              Vite + TypeScript debug screen
```

Data flows one way: devices → `DeviceEvent` channel → engine → `RideSession`
→ `TrainerCommand` → trainer, and `EngineSnapshot` → UIs. The session has no
clock of its own (time only advances through `tick(dt)`), so it is
deterministic and can later be replayed or run server-side. A multiplayer
client will subscribe to the engine's snapshots and feed other riders in the
same way the UIs do.

Rust feature `ble` (on by default in `wattsup-devices` and `wattsup-engine`)
pulls in btleplug. The engine and the device layer build and test without it,
for machines without a Bluetooth stack:
`cargo test -p wattsup-engine --no-default-features`. The CLI and the app
always include it; use `--sim-only` there.

## Building and running

### Prerequisites

Everywhere: a stable Rust toolchain (1.80 or newer, [rustup](https://rustup.rs))
and Node.js 20 or newer with npm.

**Linux** (Debian / Ubuntu):

```sh
sudo apt install bluez libdbus-1-dev pkg-config build-essential curl wget file \
  libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev patchelf
```

Arch:

```sh
sudo pacman -S --needed bluez bluez-utils dbus pkgconf base-devel openssl \
  webkit2gtk-4.1 gtk3 librsvg libayatana-appindicator patchelf
```

Then `systemctl enable --now bluetooth`. The CLI needs only BlueZ and the
D-Bus headers; the rest is for the desktop app.

**macOS**: Xcode command line tools (`xcode-select --install`). Bluetooth
needs a permission: when running from a terminal, grant it to the terminal
app (System Settings → Privacy & Security → Bluetooth). The bundled app asks
for itself through `src-tauri/Info.plist`.

**Windows**: the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
and WebView2 (already part of Windows 10/11). No pairing: BLE devices are
connected directly, and the trainer must not be connected to another app.

### Desktop app

```sh
npm install
npm run tauri dev          # hot-reloading dev build
npm run tauri build        # bundles in target/release/bundle/
```

The easiest way to pass startup flags in development is the environment
variables below, e.g. `WATTSUP_SIM_ONLY=1 WATTSUP_AUTO_SIM=1 npm run tauri dev`.
(The Tauri CLI only forwards arguments after a *second* `--`, so the flag form
is `npm run tauri dev -- -- -- --sim-only`.)

### Terminal tool

```sh
cargo run -p wattsup-cli -- scan --secs 8
cargo run -p wattsup-cli -- ride --raw --trainer ble:<id> --hr ble:<id> --controller ble:<id>
cargo run -p wattsup-cli -- ride --sim-only --trainer sim:trainer --hr sim:heart-rate --controller sim:controller
```

While riding, type `u` / `d` (shift), `erg <W>`, `sim`, `grade <%>` or `q`.

### Startup flags

| App flag | Environment | CLI flag | Effect |
| -------- | ----------- | -------- | ------ |
| `--sim-only` | `WATTSUP_SIM_ONLY=1` | `--sim-only` | No Bluetooth, only simulated devices |
| `--no-sim` | `WATTSUP_NO_SIM=1` | `--no-sim` | Hide the simulated devices |
| `--raw` | `WATTSUP_RAW=1` | `--raw` | Log every Bluetooth packet as hex |
| `--auto-sim` | `WATTSUP_AUTO_SIM=1` | | Connect the simulated trainer, strap and controller at startup |

The CLI also honours `RUST_LOG` (`RUST_LOG=debug` shows btleplug's own logging).

## Tests

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npx tsc --noEmit
npx vitest run
```

The Rust tests cover the physics, gearing and resistance maths, the byte-level
codecs, the session's command timing and an end-to-end ride on the simulated
devices. The UI tests cover the formatting helpers. CI runs all of this on
Ubuntu, Windows and macOS and builds the desktop bundles for each.

## License

MIT.
