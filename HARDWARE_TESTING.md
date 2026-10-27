# Hardware testing checklist

A step-by-step check of WattsUp against real devices:

- Wahoo KICKR CORE 2 with the Zwift Cog (14T, single speed; all gearing is virtual)
- Zwift Click v2 (keyboard shifting always stays available as a fallback)
- a Bluetooth heart-rate chest strap

Work through the sections in order. Every step says what to run, what to look
for and what to send back when it misbehaves. Each device is checked on its
own with the terminal tool first (`wattsup-cli`), because its `--raw` output
is the only way to see what the device really sends. The desktop app comes
last.

Everything below assumes the repo builds and the checks in the README pass:

```sh
cargo build --workspace
cargo test --workspace
```

Shorthand used throughout:

```sh
alias wattsup-cli='cargo run -q -p wattsup-cli --'
```

## 1. Operating-system Bluetooth setup

Do this once per machine.

### Linux (BlueZ)

WattsUp talks to BlueZ over D-Bus through `btleplug`. No root needed.

1. Install the packages.

   Debian / Ubuntu:

   ```sh
   sudo apt install bluez libdbus-1-dev pkg-config build-essential curl wget file \
     libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
     libayatana-appindicator3-dev patchelf
   ```

   Arch (incl. Omarchy):

   ```sh
   sudo pacman -S --needed bluez bluez-utils dbus pkgconf base-devel openssl \
     webkit2gtk-4.1 gtk3 librsvg libayatana-appindicator patchelf
   ```

   Only `bluez` and the D-Bus headers are needed for the CLI. The WebKitGTK
   4.1, GTK, rsvg and appindicator packages are for the Tauri app.

2. Make sure the Bluetooth service runs and the adapter is on:

   ```sh
   systemctl enable --now bluetooth
   rfkill list bluetooth        # "Soft blocked: no", "Hard blocked: no"
   bluetoothctl show            # "Powered: yes"
   ```

   If `Powered` says `no`: `bluetoothctl power on`.

3. Confirm the devices advertise at all, outside WattsUp. Wake the KICKR by
   pedalling, press a button on the Click, wet the strap and put it on:

   ```sh
   bluetoothctl
   [bluetooth]# scan on
   ```

   Within a few seconds you should see lines like `[NEW] Device F1:2C:... KICKR CORE 2 1234`,
   `... Zwift Click` and the strap's name. Then `scan off` and `exit`.

4. BlueZ must not hold its own connection to any of them. Check:

   ```sh
   bluetoothctl devices Connected
   bluetoothctl info F1:2C:...     # the KICKR's address: "Connected: no"
   ```

   If a device was paired or trusted earlier (for example by a desktop
   Bluetooth applet) and keeps auto-connecting, forget it:
   `bluetoothctl remove F1:2C:...`. BLE fitness devices do not need pairing.

5. Device ids in WattsUp are `ble:<MAC address>` on Linux, e.g. `ble:F1:2C:3B:4A:59:68`.

### macOS (CoreBluetooth)

1. The Bluetooth permission belongs to the *process that runs WattsUp*:
   - Under `cargo run` or `npm run tauri dev` that is your terminal app
     (Terminal, iTerm2, Ghostty, the VS Code terminal, ...). The first scan
     triggers a system prompt. If you dismissed it or no prompt appears and
     scans find nothing, open *System Settings → Privacy & Security →
     Bluetooth* and enable the terminal app there, then restart it.
   - The bundled app (`npm run tauri build`) carries the
     `NSBluetoothAlwaysUsageDescription` from `src-tauri/Info.plist`, so it
     asks for itself.
2. No pairing. Do not add the KICKR or the strap in *System Settings → Bluetooth*.
3. Device ids are `ble:<UUID>` (CoreBluetooth does not expose MAC addresses),
   e.g. `ble:6F1B2C3D-...`. They are stable for one machine.

### Windows (WinRT)

1. No pairing is needed and pairing can get in the way: if the KICKR, the
   Click or the strap shows up under *Settings → Bluetooth & devices* as a
   paired device, remove it there.
2. The KICKR must not be connected to any other app or device: close the
   Wahoo app and Zwift on the PC *and* on your phone or tablet (a trainer
   only accepts one control connection; the phone app in the background is
   the usual culprit).
3. Device ids are `ble:<MAC address>` like on Linux.

### All platforms

- The KICKR accepts one BLE connection for control. Close Zwift, the Wahoo
  app, TrainerRoad, Rouvy, ... everywhere before testing. If another app
  grabs control while WattsUp rides, the log shows
  `another app took control of the trainer; taking it back` and WattsUp
  re-requests control.
- Update the KICKR's firmware in the Wahoo app once, then close the app.
- Keep the Zwift Companion app closed too: it talks to the Click.

## 2. Scan

```sh
wattsup-cli scan --secs 8
```

Expected: one line per device, strongest signal first.

```
scanning for 8 s...
  ble:F1:2C:3B:4A:59:68                      KICKR CORE 2 1234            [trainer]  -58 dBm
  ble:D4:11:A0:7C:2E:90                      Zwift Click                  [controller]  -62 dBm
  ble:C8:31:..                               HRM-Dual:123456              [heart rate]  -70 dBm
  sim:trainer                                Simulated trainer            [trainer]
  sim:heart-rate                             Simulated heart rate         [heart rate]
  sim:controller                             Simulated controller         [controller]
```

- [ ] The KICKR is listed as `[trainer]`. (It advertises FTMS, service 0x1826.
      If it appears without `[trainer]`, send the `scan` output.)
- [ ] The Click is listed as `[controller]` (manufacturer id 0x094A or the
      Zwift service `00000001-19ca-...`).
- [ ] The strap is listed as `[heart rate]` (service 0x180D).
- [ ] Any `! ble: ...` line printed before the list means the Bluetooth
      provider failed; the message says why (no adapter, permission, BlueZ
      not running).

Devices that do not advertise are not found: pedal the KICKR, press the
Click, wear the strap. Run the scan a second time if something is missing;
the first scan after boot is often short of a device.

Write down the three ids; the steps below use `$KICKR`, `$CLICK` and `$HR`
for them.

## 3. Trainer: KICKR CORE 2

### 3.1 Connect and read data

```sh
wattsup-cli ride --raw --trainer $KICKR
```

`ride` scans first (6 s by default, `--scan-secs` changes it), then connects.
Once a second it prints a status line:

```
    12s   183 W (model 171)   88.0 rpm   24.3 km/h trainer   22.1 km/h virtual  HR   -  gear 12/24 (2.04)  drive 2.43  sent grade +1.20%  [trainer:ok heart rate:- controller:-]
```

Right after connecting, with `--raw`, the log shows what the trainer told us:

```
  [trainer] features: simulation=true target power=true target resistance=... (raw ........ ........)
  [trainer] power range 0..2000 W
  [trainer] control point >> 00                       (Request Control)
  [trainer] control point << 80 00 01                 (answer: opcode 00 succeeded)
  [trainer] control point >> 07                       (Start or Resume)
  [trainer] control point >> 11 00 00 78 00 28 00     (first SIM command: wind 0, grade +1.20 %, crr 0.004, cw 0)
  [trainer] indoor bike data << 44 02 ...

`>>` is what WattsUp wrote, `<<` what the trainer sent.
```

- [ ] `[trainer:ok]` in the status line within about 15 s.
- [ ] `features: simulation=true target power=true`. Without `simulation=true`
      virtual gearing cannot work; stop here and send the line.
- [ ] Every control point write is answered `80 <opcode> 01` (success).
      Anything else (`02` not supported, `03` invalid parameter, `04` failed,
      `05` control not permitted) also shows up without `--raw` as
      `control point opcode 0x.. answered ...`.
- [ ] Pedal: the W, rpm and `km/h trainer` columns update several times a
      second and look plausible (the CORE 2 reports cadence itself; a KICKR
      without cadence shows `- rpm`, see 3.4).
- [ ] Stop pedalling: within 3 s the values turn to `-` (readings expire).

### 3.2 Virtual gears change the sent grade

Keep pedalling at a steady cadence on the flat (road grade 0 %, the default).

- [ ] Type `u` + Enter: the `gear` column goes 12 → 13, the `sent grade`
      changes *on the next status line* (shifts are sent at once, not rate
      limited) and the pedals feel heavier within a second.
- [ ] Type `d` twice: gear 11, `sent grade` lower, pedals lighter.
- [ ] Shift all the way down (gear 1) and up (gear 24). At gear 24 at a
      moderate cadence the grade may read `(clamped)`: the maths asked for
      more than +20 %, the KICKR's maximum. That is expected at low cadence
      in the biggest gear.
- [ ] Type `grade 6`: the sent grade rises, the virtual speed drops over the
      next seconds. `grade 0` brings it back. `grade -5` sends a negative
      grade; the KICKR cannot push the flywheel, so resistance just drops
      to its minimum (a trainer floor of -10 % is applied before sending).
- [ ] Without any change, the same grade is re-sent about every 5 s
      (`control point >> 11 ...` in the raw log) and otherwise only when the
      computed grade moves by more than 0.1 %. Many writes per second while
      riding steadily would be a bug: send the raw log.

Each shift changes the resistance by about 7.7 % (24 gears from ratio 0.9
to 5.0 on a log scale). If a single shift feels like nothing, or like a wall,
note the `sent grade` before and after and send both lines.

### 3.3 ERG holds watts

- [ ] Type `erg 150`: the status line shows `sent ERG 150 W`, the raw log
      shows `control point >> 05 96 00` (150 = 0x0096, little-endian), and within a few seconds the W
      column settles around 150 whatever your cadence.
- [ ] Type `erg 200`: power follows. Shifting (`u`, `d`) in ERG changes only
      the virtual speed, not the resistance.
- [ ] Type `sim`: back to the virtual gears, resistance follows the gear again.

### 3.4 Calibration: drive ratio, trainer mass, aero

The gear maths depends on three things WattsUp cannot read from the trainer.
This step checks each of them.

**Drive ratio** (chainring teeth / 14). The `drive` column is measured live
from the trainer's own speed and cadence (needs ≥ 50 rpm and a few seconds).

- [ ] Pedal steadily for 20 s. `drive` settles at a stable value.
- [ ] Multiply it by 14 and compare with your chainring: 34T → 2.43,
      36T → 2.57, 38T → 2.71, 50T → 3.57. If your chainring is not 34T, note
      the number: the default `TrainerProfile::drive_ratio` (34/14) must be
      changed to match, otherwise every gear is off by the same factor.
- [ ] If `drive` stays `-` while pedalling, the KICKR is not sending speed
      or cadence. Send the raw `indoor bike data` lines.

**Trainer mass and aero** (the 75 kg assumption, and whether the trainer
honours `cw = 0`). In SIM mode WattsUp sends the KICKR a grade computed for
a 75 kg rider+bike and a wind coefficient of 0, so the trainer's own aero
model should be off. If either guess is wrong, the trainer makes you produce
more or less power than the virtual road needs. The status line prints both:
`W` (measured) and `model` (what the virtual gear and road ask for).

Ride on the flat (`grade 0`, `sim`) in a middle gear and hold a steady
cadence for 20 s at each of two cadences:

| cadence | measured W | model W | ratio measured / model |
| ------- | ---------- | ------- | ---------------------- |
| ~60 rpm |            |         |                        |
| ~95 rpm |            |         |                        |

Then the same two rows at `grade 6`.

Reading the table:

- Ratios near 1.0 everywhere: both guesses are fine.
- The same ratio at both cadences (say 1.07 everywhere): the trainer's mass
  assumption differs from 75 kg; the real value is about 75 × ratio. Note
  it: `TrainerProfile::assumed_mass_kg` must be changed.
- A ratio that grows with cadence (and more so on the flat than on the
  climb): the KICKR adds its own aero drag on top of our grade even though
  we send `cw = 0`. Then `sim_cw` in the profile has to be set to the drag
  the trainer really applies, so WattsUp can subtract it.
- A ratio near 1.0 on the climb but not on the flat points at the same aero
  issue.

Send the filled table together with a `--raw` log of the ride; the raw
`11 ...` commands show exactly which grade and `cw` were sent.

## 4. Heart-rate strap

```sh
wattsup-cli ride --raw --hr $HR
```

- [ ] `[heart rate:ok]` within a few seconds (wet the electrodes; a dry strap
      advertises but sends 0 or nothing).
- [ ] `HR` column shows a plausible value that updates every second; raw log
      lines `heart rate << 16 5a ..` or `<< 00 5a` (flags byte, then bpm).
- [ ] Take the strap off: after 3 s the column shows `-`.
- [ ] Walk the strap out of range and back: the status goes `retry` and
      `ok` again by itself (the reconnect runner backs off 2, 4, 8, 15 s).

## 5. Controller: Zwift Click v2

### 5.1 The Click v2 caveat

The Click v2 only talks freely to apps for a while after the official Zwift
app connected to it. Unless Zwift connected to it recently, it stops sending
button presses about a minute after WattsUp connects, and announces that with
`FF 05 00 EA 05` or `FF 05 00 FA 05` on the async characteristic. (Found and
documented by the BikeControl project in its troubleshooting guide; our
decoder reports that packet as `Stopped`.)

WattsUp reconnects when it sees that packet. The log then says
`Click v2 stopped sending buttons (connect it in the Zwift app once to unlock it)`
and the controller goes `retry` → `ok`.

Workaround before a ride: open Zwift (on any device), let it connect to the
Click once, close Zwift completely, then start WattsUp.

Keyboard shifting (↑ / ] harder, ↓ / [ easier in the app; `u` / `d` in the
CLI) works regardless, so a misbehaving Click never blocks a ride.

### 5.2 Connect and press

```sh
wattsup-cli ride --raw --controller $CLICK
```

- [ ] `[controller:ok]` and in the log `handshake sent (Some(ClickV2Right))`
      or `(Some(ClickV2Left))` (`Some(Click)` for a v1). `None` means the
      manufacturer data was not understood: send the `scan` output and the
      raw log.
- [ ] A `handshake answered (...)` line follows. With `--raw` the handshake
      bytes are visible: we write `52 69 64 65 4f 6e` ("RideOn") and, for a
      v2, `ff 04 00`.
- [ ] Press the `+` button: the `gear` column goes up by one on the next
      status line. Press `−`: down by one. A held button shifts once (edges,
      not levels). If the directions are swapped on your unit, say so: the
      v2 reuses the Zwift Ride button map and the mapping is a guess.
- [ ] A battery percentage appears in the log / debug screen within a minute.
- [ ] Keep it connected for 3 minutes without Zwift having touched it, pressing
      a button every 20 s. Note when presses stop arriving and whether the
      `Stopped` reconnect kicks in. Send the raw log of this run, it tells
      us what your firmware does.
- [ ] Repeat after connecting the Click in Zwift once. Presses should keep
      working for the whole 3 minutes.

If the Click is not found at all: a Click v2 that has never been set up
sometimes needs a firmware update through the Zwift Companion app first.

## 6. Everything together, in the app

```sh
WATTSUP_RAW=1 npm run tauri dev    # or: cargo run -p wattsup -- --raw
```

- [ ] *Scan* lists the three devices; *Use as trainer / heart rate /
      controller* connects each, the slot turns green.
- [ ] Power, cadence, speed, heart rate and the gear strip move while you ride.
- [ ] Click buttons, ↑/↓ keys and the on-screen shift buttons all move the
      same gear.
- [ ] The *Sent to trainer* tile shows the grade and a warning line when it
      is clamped.
- [ ] The *Measured drive ratio* tile shows `≈ 34T over a 14T Cog` (or your
      chainring).
- [ ] *Model* under the power tile is close to the measured power on the flat
      at a steady cadence (see 3.4).
- [ ] Switch to ERG, change the target with −10 / +10, switch back to SIM.
- [ ] Turn the KICKR off and on: the slot goes *reconnecting*, then
      *connected*, and the last grade is sent again without any click.

The app log at the bottom shows the same lines as the CLI. To capture them,
start the app from a terminal with `--raw` and copy the terminal output.

## 7. What to send when something misbehaves

1. The `wattsup-cli scan --secs 8` output.
2. The full output of the `ride --raw ...` run that showed the problem,
   including the status lines before and after it happened.
3. OS and version, `bluetoothctl --version` on Linux.
4. Which chainring sits on the Cog and the KICKR firmware version from the
   Wahoo app.
5. For Click problems: whether Zwift connected to the Click before the run,
   and the firmware version from Zwift Companion.

Raw dumps are hex per packet (`indoor bike data << 44 02 ...`, `async << 37 08 ...`),
nothing personal in them beyond heart rate.

## Known unverified guesses

Kept here until the checks above settle them:

| Guess | Where | How this checklist settles it |
| ----- | ----- | ----------------------------- |
| KICKR assumes 75 kg in SIM mode | `TrainerProfile::assumed_mass_kg` | 3.4, constant power ratio |
| `cw = 0` turns the KICKR's own aero off | `TrainerProfile::sim_cw` | 3.4, cadence-dependent ratio |
| Default drive ratio 34/14 | `TrainerProfile::drive_ratio` | 3.4, `drive` column |
| Click v2 stops after ~1 min and sends `FF 05 00 EA 05` | `protocol/zwift.rs` | 5.2, 3-minute run |
