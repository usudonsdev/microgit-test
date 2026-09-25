#!/usr/bin/env node
/**
 * OverlayFS ゴールデンテストの期待値を、本物の Linux カーネルで記録する（Issue #10）。
 *
 * 使い方: node scripts/golden/record-kernel.mjs
 *   Linux:   unshare -Urm で非特権のユーザー／mount 名前空間に入って実行する（カーネル 5.11 以降）
 *   Windows: wsl.exe 経由で同じことをする（WSL2 のディストリビューションが要る）
 * 出力: test/golden/overlayfs/<scenario>.golden と meta.json
 *
 * コミットのモデル（要件定義書 FR-2 の初期案そのまま）:
 *   コミット i は、祖先の層を lowerdir に積み、空の upperdir に ops を書き込んで unmount したもの。
 *   凍結した upperdir がそのまま次のコミットの lower になる。
 *   期待値は、祖先＋自分の層だけを lowerdir にした読み取り専用 mount（FR-2 の view）の中身。
 *
 * mount オプションは userxattr だけを明示し、残りはカーネルの既定に任せている。
 * 固定する値は Issue #12（O-13）で決める。決まったら MOUNT_OPTS を直して取り直す。
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chainOf, scenarios, validateScenarios } from './overlayfs-scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'test', 'golden', 'overlayfs');
// 非特権（ユーザー名前空間）で mount するには userxattr が必須
const MOUNT_OPTS = 'userxattr';

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function opToShell(op) {
    const [kind, a, b] = op;
    switch (kind) {
        case 'write': return `mkdir -p -- "$(dirname -- ${q(a)})" && printf '%s' ${q(b)} > ${q(a)}`;
        case 'rm': return `rm -- ${q(a)}`;
        case 'rmdir': return `rm -r -- ${q(a)}`;
        case 'mkdir': return `mkdir -p -- ${q(a)}`;
        case 'mv': return `mkdir -p -- "$(dirname -- ${q(b)})" && mv -T -- ${q(a)} ${q(b)}`;
        default: throw new Error(`unknown op: ${kind}`);
    }
}

function buildScript() {
    const lines = [
        'set -eu',
        'T=$(mktemp -d)',
        // workdir はユーザー名前空間の root 所有で残るので、名前空間の中で消す
        'trap \'rm -rf "$T"\' EXIT',
        // mount オプションからパスを落として、フラグだけを出す
        'opts() { grep " $1 overlay " /proc/mounts | cut -d" " -f4 | tr , "\\n" | grep -Ev "^(lowerdir|upperdir|workdir)=" | paste -sd, -; }',
        'dump() {',
        '  (cd "$1" && find . -mindepth 1 -print0 | LC_ALL=C sort -z | while IFS= read -r -d "" p; do',
        '    r=${p#./}',
        '    if [ -L "$p" ]; then printf "l\\t%s\\t%s\\n" "$r" "$(readlink -- "$p")"',
        '    elif [ -d "$p" ]; then printf "d\\t%s\\n" "$r"',
        '    elif [ -f "$p" ]; then printf "f\\t%s\\t%s\\n" "$r" "$(sha256sum < "$p" | cut -d" " -f1)"',
        '    else printf "o\\t%s\\n" "$r"',
        '    fi',
        '  done)',
        '}',
        'echo "@kernel $(uname -r)"',
    ];
    let first = true;
    for (const s of scenarios) {
        lines.push(`S="$T/${s.name}"`, 'mkdir -p "$S/base" "$S/m"', `echo "@scenario ${s.name}"`);
        s.commits.forEach((c, i) => {
            const chain = chainOf(s, i);
            // lowerdir は上の層が先
            const lowers = chain.slice(0, -1).reverse().map((n) => `$S/u${n}`).concat('$S/base').join(':');
            const views = chain.slice().reverse().map((n) => `$S/u${n}`).concat('$S/base').join(':');
            lines.push(
                `mkdir -p "$S/u${i}" "$S/w${i}"`,
                `mount -t overlay overlay -o "lowerdir=${lowers},upperdir=$S/u${i},workdir=$S/w${i},${MOUNT_OPTS}" "$S/m"`,
            );
            if (first) { lines.push('echo "@write-options $(opts "$S/m")"'); }
            lines.push(
                `(cd "$S/m" && ${c.ops.map(opToShell).join(' && ') || 'true'})`,
                'umount "$S/m"',
                `mount -t overlay overlay -o "lowerdir=${views},${MOUNT_OPTS}" "$S/m"`,
            );
            if (first) { lines.push('echo "@view-options $(opts "$S/m")"'); }
            lines.push(`echo "@commit ${i + 1}"`, 'dump "$S/m"', 'umount "$S/m"');
            first = false;
        });
    }
    lines.push('echo "@end"');
    return lines.join('\n') + '\n';
}

function runInLinuxNamespace(script) {
    let cmd;
    if (process.platform === 'linux') {
        cmd = ['unshare', ['-Urm', 'bash', '-s']];
    } else if (process.platform === 'win32') {
        cmd = ['wsl.exe', ['-e', 'unshare', '-Urm', 'bash', '-s']];
    } else {
        throw new Error(`Linux カーネルが要る（Linux か、WSL2 のある Windows で実行する）: platform=${process.platform}`);
    }
    const r = spawnSync(cmd[0], cmd[1], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) { throw r.error; }
    if (r.status !== 0 || !r.stdout.includes('@end')) {
        throw new Error(`カーネル側の記録に失敗した (exit ${r.status})\n${r.stderr}`);
    }
    return r.stdout;
}

function parse(stdout) {
    const meta = {};
    const goldens = new Map();
    let current;
    for (const line of stdout.split('\n')) {
        if (!line) { continue; }
        const m = /^@(\S+)(?: (.*))?$/.exec(line);
        if (!m) {
            current.push(line);
            continue;
        }
        const [, tag, value = ''] = m;
        if (tag === 'kernel') { meta.kernel = value; }
        else if (tag === 'write-options') { meta.writeMountOptions = value; }
        else if (tag === 'view-options') { meta.viewMountOptions = value; }
        else if (tag === 'scenario') { current = []; goldens.set(value, current); }
        else if (tag === 'commit') { current.push(`## commit ${value}`); }
    }
    return { meta, goldens };
}

validateScenarios();
const { meta, goldens } = parse(runInLinuxNamespace(buildScript()));
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith('.golden')) { fs.rmSync(path.join(OUT_DIR, name)); }
}
for (const [name, lines] of goldens) {
    const header = '# scripts/golden/record-kernel.mjs が生成。手で直さない\n';
    fs.writeFileSync(path.join(OUT_DIR, `${name}.golden`), header + lines.join('\n') + '\n');
}
fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({ ...meta, requestedMountOptions: MOUNT_OPTS, model: 'upper を凍結して次の lower にする（FR-2 初期案）' }, null, 2) + '\n',
);
console.log(`recorded ${goldens.size} scenarios`, meta);
