import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const o = require(path.join(ROOT, 'out', 'overlay.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'microgit-overlay-'));
const paths = o.ensureOverlayDirs(tmp);
const h1 = 'a'.repeat(40);
const h2 = 'b'.repeat(40);
const h3 = 'c'.repeat(40);

function writeLayer(hash, files) {
  const dir = o.layerDir(paths, hash);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) {
      const wo = path.join(dir, ...o.whiteoutRelPath(rel).split('/'));
      fs.mkdirSync(path.dirname(wo), { recursive: true });
      fs.writeFileSync(wo, '');
      continue;
    }
    const out = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
  }
}

writeLayer(h1, { 'keep.txt': 'KEEP', 'src/a.txt': 'A1' });
o.expandViewAfterExport(paths, h1, undefined);
writeLayer(h2, { 'src/a.txt': 'A2', 'keep.txt': null });
if (o.expandViewAfterExport(paths, h2, h1) !== 'incremental') throw new Error('expected incremental');

const r1 = o.checkoutLayers(paths, [h1, h2], 'mb-1');
if (fs.existsSync(path.join(paths.merge, 'keep.txt'))) throw new Error('keep.txt should be whiteout-removed');
if (fs.readFileSync(path.join(paths.merge, 'src/a.txt'), 'utf8') !== 'A2') throw new Error('a.txt != A2');

const r2 = o.checkoutLayers(paths, [h1, h2], 'mb-1');
if (r2.method !== 'cached-view' || r2.appliedLayers !== 0) throw new Error(`cache miss: ${JSON.stringify(r2)}`);

writeLayer(h3, { 'src/a.txt': 'B1', 'only-b.txt': 'BONLY' });
o.expandViewAfterExport(paths, h3, h1);
o.checkoutLayers(paths, [h1, h3], 'mb-2');
if (!fs.existsSync(path.join(paths.merge, 'only-b.txt'))) throw new Error('only-b missing on B');

o.checkoutLayers(paths, [h1, h2], 'mb-1');
if (fs.existsSync(path.join(paths.merge, 'only-b.txt'))) throw new Error('only-b leaked after jump back');
if (fs.readFileSync(path.join(paths.merge, 'src/a.txt'), 'utf8') !== 'A2') throw new Error('A not restored');

console.log('OK', { r1: r1.method, r2: r2.method, platform: process.platform });
fs.rmSync(tmp, { recursive: true, force: true });
