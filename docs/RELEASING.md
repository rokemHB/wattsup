# Releasing WattsUp

Installers for Linux, Windows and macOS are built by GitHub Actions and published on the
repository's [Releases page](https://github.com/rokemHB/wattsup/releases). That page is where
people download WattsUp; the README links to the latest release.

## Versions

WattsUp uses [Semantic Versioning](https://semver.org/). While it is 0.x:

- **0.Y.0** (a minor release) brings new features, and may change saved data or settings in
  ways that need a note in the changelog.
- **0.Y.Z** (a patch release) only fixes bugs.
- **0.Y.Z-beta.N** is a pre-release for testing. GitHub marks it as one and it never shows as
  "latest".

1.0.0 is for when Robin calls it finished enough. From then on a breaking change (a saved
ride or route that no longer loads) needs a major version.

The version is written in five places, all set by `tools/release/bump.sh`: the Cargo
workspace (`Cargo.toml`, and so `Cargo.lock`), `package.json`, `package-lock.json` and
`src-tauri/tauri.conf.json`. The release workflow refuses a tag that disagrees with any of
them, or that has no section in `CHANGELOG.md`.

## Branches and tags

- **master** is the trunk. It is always releasable: CI builds the app bundles for all three
  systems on every push.
- **Feature branches** (`feat/...`, `fix/...`) are merged into master.
- **Tags `vX.Y.Z`** mark releases. They are annotated tags on master, and pushing one starts
  `.github/workflows/release.yml`. A published tag is never moved or deleted: if a release is
  broken, the fix is a new patch release.
- **Release branches `release/X.Y`** start at the tag `vX.Y.0` and carry the patch releases of
  that line (`v0.1.1`, `v0.1.2`, ...). A fix lands on master first and is cherry-picked onto
  the release branch, so it is never lost in the next minor release. Once `X.(Y+1).0` is out,
  the old branch is kept for the record but no longer patched.

## Making a release

From master, or from `release/X.Y` for a patch:

1. Move the finished items into `CHANGELOG.md` under `## [Unreleased]`, written for riders,
   not developers.
2. Set the version everywhere:
   ```sh
   tools/release/bump.sh 0.2.0
   ```
   It moves the Unreleased notes under `## [0.2.0] - <today>`. Add the compare link at the
   bottom of the changelog
   (`[0.2.0]: https://github.com/rokemHB/wattsup/compare/v0.1.0...v0.2.0`).
3. Run the five checks (see CLAUDE.md), commit (`Release 0.2.0`) and push.
4. Tag and push the tag:
   ```sh
   git tag -a v0.2.0 -m "WattsUp 0.2.0"
   git push origin v0.2.0
   ```
5. For a minor release, start its release branch: `git push origin v0.2.0:refs/heads/release/0.2`.

The workflow then:

1. **Drafts the release.** It checks the versions and drafts a GitHub Release whose notes are
   the changelog section followed by `tools/release/downloads.md`, which explains which file to
   pick and how to open an unsigned build.
2. **Builds and uploads.** It builds on four runners and attaches the installers:
   | Runner | Files |
   | --- | --- |
   | Ubuntu 22.04 | AppImage, `.deb` and `.rpm` for x86_64. 22.04's older glibc lets the AppImage run on older distributions too. |
   | Ubuntu 22.04 ARM | The same for aarch64 |
   | Windows | NSIS `-setup.exe` and `.msi` |
   | macOS | One universal `.dmg` for Apple Silicon and Intel, ad-hoc signed |
3. **Publishes.** Once every build has succeeded, it publishes the release. If a build fails,
   the release stays a draft: fix the cause, then re-run the failed jobs from the Actions
   tab. The re-run reuses the draft. If the fix needs a new commit, delete the draft and the
   tag on GitHub, then tag again. This is the one case where a tag may move: nobody has
   downloaded from it yet.

## Signing

The builds are not signed with a paid certificate, so users see one warning on the first start
(`tools/release/downloads.md` says what to click).

- **macOS** builds are ad-hoc signed (`signingIdentity: "-"` in `tauri.conf.json`). Without it,
  Apple Silicon reports a downloaded app as "damaged". Real signing and notarisation need an
  Apple Developer account (99 USD a year). With one, the certificate and app-specific password
  go into the repository secrets that tauri-action reads (`APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`).
- **Windows** SmartScreen warns until a build has a reputation or a code-signing certificate.
  Azure Trusted Signing is the cheap way to get one.

## Checking a build before tagging

Every push to master already uploads the bundles as workflow artifacts (CI, job "App bundle").
Download them from the run's page, or with `gh run download <run id>`, and try them before
tagging.
