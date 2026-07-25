#!/usr/bin/env bash
# Node.js Overlay（空間で時間を買う）スモーク
# 使い方: ./scripts/overlay-smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm run compile >/dev/null

node <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ensureOverlayDirs,
  checkoutLayers,
  listFilesRecursive,
  whiteoutRelPath,
  isViewReady,
  expandViewAfterExport,
  layerDir,
  viewDir,
} = require("./out/overlay.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "microgit-overlay-"));
const paths = ensureOverlayDirs(tmp);

const h1 = "a".repeat(40);
const h2 = "b".repeat(40);
const h3 = "c".repeat(40); // sibling of h2 from h1

function writeLayer(hash, files) {
  const dir = layerDir(paths, hash);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) {
      const wo = path.join(dir, ...whiteoutRelPath(rel).split("/"));
      fs.mkdirSync(path.dirname(wo), { recursive: true });
      fs.writeFileSync(wo, "");
      const victim = path.join(dir, ...rel.split("/"));
      if (fs.existsSync(victim)) fs.rmSync(victim, { force: true });
      continue;
    }
    const out = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
}

// --- branch A: h1 -> h2 ---
writeLayer(h1, { "keep.txt": "KEEP", "src/a.txt": "A1" });
expandViewAfterExport(paths, h1, undefined);
if (!isViewReady(paths, h1)) throw new Error("h1 view missing");

writeLayer(h2, { "src/a.txt": "A2", "keep.txt": null });
const mInc = expandViewAfterExport(paths, h2, h1);
if (mInc !== "incremental") throw new Error(`expected incremental, got ${mInc}`);
if (!isViewReady(paths, h2)) throw new Error("h2 view missing");

const r1 = checkoutLayers(paths, [h1, h2], "mb-1");
if (r1.method !== "cached-view") throw new Error(`first checkout should use view, got ${r1.method}`);
if (fs.existsSync(path.join(paths.merge, "keep.txt"))) throw new Error("keep.txt should be whiteout-removed");
if (fs.readFileSync(path.join(paths.merge, "src/a.txt"), "utf8") !== "A2") throw new Error("a.txt != A2");

// second checkout: cached-view, appliedLayers=0
const r2 = checkoutLayers(paths, [h1, h2], "mb-1");
if (r2.method !== "cached-view" || r2.appliedLayers !== 0) {
  throw new Error(`cache miss: ${JSON.stringify(r2)}`);
}

// --- sibling branch B: h1 -> h3 ---
writeLayer(h3, { "src/a.txt": "B1", "only-b.txt": "BONLY" });
expandViewAfterExport(paths, h3, h1);

const rA = checkoutLayers(paths, [h1, h2], "mb-1");
const filesA = new Set(listFilesRecursive(paths.merge));
if (filesA.has("only-b.txt")) throw new Error("sibling leak: only-b visible on A");
if (filesA.has("keep.txt")) throw new Error("keep should stay deleted on A");

const rB = checkoutLayers(paths, [h1, h3], "mb-2");
const filesB = listFilesRecursive(paths.merge).sort();
const aB = fs.readFileSync(path.join(paths.merge, "src/a.txt"), "utf8");
if (aB !== "B1") throw new Error(`branch B a.txt=${aB}`);
if (!filesB.includes("only-b.txt")) throw new Error("only-b missing on B");
if (!filesB.includes("keep.txt")) throw new Error("keep should exist on B (not deleted there)");
if (rB.method !== "cached-view") throw new Error(`B checkout method=${rB.method}`);

// jump back to A: must restore isolation
checkoutLayers(paths, [h1, h2], "mb-1");
if (fs.existsSync(path.join(paths.merge, "only-b.txt"))) throw new Error("only-b leaked after jump back");
if (fs.readFileSync(path.join(paths.merge, "src/a.txt"), "utf8") !== "A2") throw new Error("A not restored");

console.log("OK", {
  platform: process.platform,
  methods: { r1: r1.method, r2: r2.method, rA: rA.method, rB: rB.method },
  views: [h1, h2, h3].map((h) => isViewReady(paths, h)),
  viewDir: viewDir(paths, h2),
});
fs.rmSync(tmp, { recursive: true, force: true });
NODE
