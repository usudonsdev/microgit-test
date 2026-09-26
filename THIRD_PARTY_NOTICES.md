# Third-party notices / 同梱している第三者のソフトウェア

MicroGit itself is licensed under the terms in [LICENCE.md](LICENCE.md).
The platform-specific packages (VSIX) of MicroGit 5 also contain the third-party software listed below, used by the optional kernel OverlayFS backend.
The universal package contains none of it.

MicroGit 本体のライセンスは [LICENCE.md](LICENCE.md) のとおり。MicroGit 5 のプラットフォーム別の VSIX には、カーネル版の OverlayFS のために、次の第三者のソフトウェアも入っている。universal の VSIX には入っていない。

## What is in which package / どの VSIX に何が入っているか

| Component | Version | License | win32-x64 | linux-x64 / linux-arm64 | Where in the VSIX |
|---|---|---|---|---|---|
| Linux kernel | 6.18.53 | GPL-2.0 (with Linux-syscall-note) | yes (inside the guest image) | no | `resources/kernel/guest/x86_64/Image`, license: `resources/kernel/licenses/linux/` |
| Go standard library and runtime (statically linked into the MicroGit agent) | 1.27.1 | BSD-3-Clause | yes (inside the guest image) | yes | `resources/kernel/linux-*/microgit-agent`, license: `resources/kernel/licenses/go/LICENSE` |
| QEMU (`qemu-system-x86_64`, built by MicroGit with a reduced device set) | 11.1.1 | GPL-2.0 (parts under other GPL-compatible licenses, see `COPYING`, `LICENSE`) | yes | no | `resources/kernel/win32-x64/qemu/`, license: `.../qemu/licenses/qemu/` |
| SeaBIOS (`bios-256k.bin`, from the QEMU source tree) | as shipped with QEMU 11.1.1 | LGPL-3.0 | yes | no | `.../qemu/share/`, license: `.../qemu/licenses/seabios/` |
| QEMU option ROMs (`linuxboot_dma.bin`, `kvmvapic.bin`) | as shipped with QEMU 11.1.1 | GPL-2.0 | yes | no | `.../qemu/share/` |
| DLLs used by QEMU (GLib, GIO, GObject, GModule, libintl, iconv, libffi, PCRE2, pixman, libgcc, winpthreads, zlib) | Fedora 44 MinGW packages, see `packages.tsv` | per package, see `packages.tsv` (for example GLib: LGPL-2.1-or-later) | yes | no | `resources/kernel/win32-x64/qemu/*.dll`, licenses: `.../qemu/licenses/<package>/` and `.../qemu/licenses/packages.tsv` |

`packages.tsv` is written at build time by `windows/qemu/build.sh`, which asks `rpm` which Fedora package each DLL came from, and records the version, license and source RPM of that package.

`packages.tsv` は `windows/qemu/build.sh` がビルドのときに書く。DLL ごとに、どの Fedora のパッケージから来たかを `rpm` に聞き、そのパッケージの版・ライセンス・ソース RPM を記録している。

## Source code / ソースコード

The complete corresponding source code of the GPL and LGPL components above, and the scripts and configuration used to build them, is published with every release on the GitHub release page of this repository as `third-party-sources-<version>.tar`:

上の GPL・LGPL の部品の完全なソースコードと、ビルドに使ったスクリプトと設定は、リリースごとに、このリポジトリの GitHub のリリースのページに `third-party-sources-<版>.tar` として置く。

- `linux-6.18.53.tar.xz` (from kernel.org, sha256 pinned in `guest/kernel/version.env`)
- `qemu-11.1.1.tar.xz` (from download.qemu.org, sha256 pinned in `windows/qemu/version.env`; includes the SeaBIOS and option ROM sources)
- `qemu-win32-dlls/*.src.rpm` (the Fedora source RPMs of the DLLs, downloaded in the same build container)
- `microgit-build/` (the kernel configuration fragments, `guest/build.sh`, the agent source, `windows/qemu/build.sh`)
- `SHA256SUMS`

The same build scripts are in this repository (`guest/`, `windows/qemu/`), and the GitHub Actions workflow `.github/workflows/package.yml` shows exactly how each package was built.

同じビルドのスクリプトはこのリポジトリ（`guest/`、`windows/qemu/`）にあり、各 VSIX がどう作られたかは GitHub Actions のワークフロー `.github/workflows/package.yml` に残っている。
