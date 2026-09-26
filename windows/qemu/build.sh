#!/usr/bin/env bash
# MicroGit に同梱する、Windows 用の小さい QEMU をクロスビルドする（Issue #18、docs/windows-backend.md §4）。
#
# 使い方: windows/qemu/build.sh     （Fedora と MinGW の環境で。CI は fedora のコンテナで流す）
# 必要なもの（Fedora）: gcc make python3 ninja-build bzip2 xz tar diffutils findutils perl
#                       mingw64-gcc mingw64-glib2 mingw64-pixman mingw64-zlib mingw64-pkg-config
# 出力: windows/qemu/out/qemu-win/ に qemu-system-x86_64.exe、必要な DLL、share/（ファームウェア）、sizes.txt
#
# 方針: 対象は x86_64 のエミュレーションだけ（--target-list=x86_64-softmmu）。アクセラレータは WHPX と TCG。
# GUI・音声・USB・ネットワーク・VNC・SPICE・圧縮形式・暗号ライブラリなど、MicroGit の最小ゲスト
# （-nodefaults、virtio-serial だけ）に要らないものは外す。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$HERE/out}"
CACHE="$HERE/.cache"
# shellcheck source=version.env
source "$HERE/version.env"
CROSS=x86_64-w64-mingw32
SYSROOT_BIN="/usr/$CROSS/sys-root/mingw/bin"

mkdir -p "$CACHE" "$OUT"

echo "== source qemu-$QEMU_VERSION"
tarball="$CACHE/qemu-$QEMU_VERSION.tar.xz"
if [[ ! -f "$tarball" ]]; then
    curl -fsSL -o "$tarball.tmp" "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz"
    mv "$tarball.tmp" "$tarball"
fi
echo "$QEMU_SHA256  $tarball" | sha256sum -c -
src="$CACHE/qemu-$QEMU_VERSION"
[[ -d "$src" ]] || tar -xJf "$tarball" -C "$CACHE"

echo "== configure"
build="$OUT/build"
mkdir -p "$build"
cd "$build"
"$src/configure" \
    --cross-prefix="$CROSS-" \
    --target-list=x86_64-softmmu \
    --enable-whpx --enable-tcg \
    --disable-docs --disable-tools --disable-guest-agent \
    --disable-gtk --disable-sdl --disable-vnc --disable-spice --disable-opengl \
    --disable-curl --disable-slirp --disable-libusb --disable-usb-redir --disable-smartcard \
    --disable-capstone --disable-gnutls --disable-nettle --disable-gcrypt \
    --disable-png --disable-zstd --disable-lzo --disable-snappy --disable-bzip2 \
    --disable-libssh --disable-brlapi --disable-curses --disable-iconv \
    --audio-drv-list= --disable-plugins --disable-debug-info --disable-werror

echo "== build"
make -j"$(nproc)" qemu-system-x86_64.exe

echo "== collect"
dest="$OUT/qemu-win"
rm -rf "$dest"
mkdir -p "$dest/share"
cp qemu-system-x86_64.exe "$dest/"
"$CROSS-strip" "$dest/qemu-system-x86_64.exe"

# 実行ファイルが読む DLL を、MinGW の sysroot から芋づる式に集める（Windows に最初からある DLL は除く）
declare -A seen=()
queue=("$dest/qemu-system-x86_64.exe")
while ((${#queue[@]})); do
    f="${queue[0]}"; queue=("${queue[@]:1}")
    while read -r dll; do
        [[ -n "$dll" && -z "${seen[$dll]:-}" ]] || continue
        seen[$dll]=1
        if [[ -f "$SYSROOT_BIN/$dll" ]]; then
            cp "$SYSROOT_BIN/$dll" "$dest/"
            queue+=("$dest/$dll")
        fi
    done < <("$CROSS-objdump" -p "$f" | sed -n 's/^\s*DLL Name: //p')
done

# ファームウェア: SeaBIOS と、-kernel で直接起動するためのオプション ROM
for fw in bios-256k.bin linuxboot_dma.bin kvmvapic.bin; do
    cp "$src/pc-bios/$fw" "$dest/share/"
done

{
    echo "qemu        $QEMU_VERSION (x86_64-softmmu, whpx+tcg)"
    echo "exe         $(stat -c %s "$dest/qemu-system-x86_64.exe") bytes"
    echo "dlls        $(ls "$dest"/*.dll 2>/dev/null | wc -l) files, $(cat "$dest"/*.dll 2>/dev/null | wc -c) bytes"
    echo "share       $(cat "$dest"/share/* | wc -c) bytes"
    echo "total       $(du -sb "$dest" | cut -f1) bytes"
    # VSIX は zip なので、利用者がダウンロードする大きさはこれに近い（zip コマンドは Fedora のコンテナに無いので Python で測る）
    echo "zip         $(python3 -c 'import io,os,sys,zipfile
b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED,compresslevel=9)
for r,_,fs in os.walk(sys.argv[1]):
    [z.write(os.path.join(r,f)) for f in fs]
z.close(); print(len(b.getvalue()))' "$dest") bytes (参考: zip で圧縮した大きさ)"
    echo "dll list    $(cd "$dest" && ls *.dll | tr '\n' ' ')"
} | tee "$OUT/sizes.txt"
