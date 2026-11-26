## Which file do I need?

| System | File |
| --- | --- |
| Windows 10/11 | `WattsUp_<version>_x64-setup.exe` (or the `.msi`) |
| macOS, Apple Silicon or Intel | `WattsUp_<version>_universal.dmg` |
| Linux, any distribution | `WattsUp_<version>_amd64.AppImage` (`aarch64` for ARM) |
| Debian, Ubuntu, Mint | `WattsUp_<version>_amd64.deb` |
| Fedora, openSUSE | `WattsUp-<version>-1.x86_64.rpm` |

The builds are not signed with a paid developer certificate, so your system will ask once
before it opens them:

- **Windows**: SmartScreen says "Windows protected your PC". Click **More info**, then
  **Run anyway**.
- **macOS**: open the app once, then go to **System Settings → Privacy & Security** and click
  **Open Anyway** next to WattsUp. Allow Bluetooth when it asks.
- **Linux AppImage**: make it executable (`chmod +x WattsUp_*.AppImage`) and run it. Bluetooth
  needs BlueZ, which every desktop distribution has.

The first ride on a map downloads its terrain and aerial photos in the background (the whole
Mallorca island is about 175 MB; "Download all terrain" on the map screen fetches it all at once).
