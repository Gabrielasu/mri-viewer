/*
 * End-to-end verification of the viewer's parsers against the real disc
 * images, cross-checked with pydicom-generated ground truth and bsdtar.
 *
 * Usage:  node test/run-tests.js
 * Env:    ISO_DIR       — directory holding the private .iso files (required)
 *         ISO_FILES     — comma-separated filenames; defaults to every ISO in ISO_DIR
 *         GROUND_TRUTH  — private JSON fixture; defaults to test/fixtures/groundtruth.json
 *         DATA_DIR      — optional extracted disc contents for byte cross-checks
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { Iso9660 } = require('../js/iso9660.js');
const DICOM = require('../js/dicom.js');
const DICOMDIR = require('../js/dicomdir.js');
const STACK = require('../js/stack.js');

const ISO_DIR = process.env.ISO_DIR;
if (!ISO_DIR) throw new Error('Set ISO_DIR to the folder containing the private ISO files');
const requestedFiles = (process.env.ISO_FILES || '').split(',').map((s) => s.trim()).filter(Boolean);
const isoFiles = requestedFiles.length ? requestedFiles : fs.readdirSync(ISO_DIR)
  .filter((name) => /\.iso$/i.test(name)).sort();
if (!isoFiles.length) throw new Error(`No ISO files found in ${ISO_DIR}`);
const ISOS = Object.fromEntries(isoFiles.map((name, i) => [`disc${i + 1}`, path.join(ISO_DIR, name)]));
const gtPath = process.env.GROUND_TRUTH || path.join(__dirname, 'fixtures/groundtruth.json');
if (!fs.existsSync(gtPath)) throw new Error(`Private ground-truth fixture not found: ${gtPath}`);
const GT = JSON.parse(fs.readFileSync(gtPath, 'utf8'));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

class FileSource {
  constructor(fd, size, name) { this.fd = fd; this.size = size; this.name = name; }
  static open(p) {
    const fd = fs.openSync(p, 'r');
    return new FileSource(fd, fs.fstatSync(fd).size, path.basename(p));
  }
  async read(offset, length) {
    const end = Math.min(offset + length, this.size);
    if (offset >= this.size) return new Uint8Array(0);
    const buf = Buffer.alloc(end - offset);
    let done = 0;
    while (done < buf.length) {
      const n = fs.readSync(this.fd, buf, done, buf.length - done, offset + done);
      if (n <= 0) break;
      done += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, done);
  }
}

async function readHeader(iso, entry) {
  const size = entry.size;
  for (const n of [16384, 131072, 1048576, size]) {
    const want = Math.min(n, size);
    const bytes = await iso.readFile(entry, 0, want);
    try {
      const ds = DICOM.parse(bytes);
      if (ds.pixel || want >= size) return ds;
    } catch (e) {
      if (!(e instanceof DICOM.NeedMoreData)) throw e;
      if (want >= size) throw new Error('truncated');
    }
  }
  throw new Error('unparseable');
}

async function main() {
  for (const [disc, isoPath] of Object.entries(ISOS)) {
    console.log(`\n=== ${disc}: ${path.basename(isoPath)}`);
    if (!fs.existsSync(isoPath)) { console.error('  SKIP — iso not found'); continue; }
    const src = FileSource.open(isoPath);
    const iso = await Iso9660.open(src);
    const root = await iso.readTree();

    // --- ISO file list matches bsdtar exactly
    const ours = new Set(root.files.map((f) => f.path.toUpperCase()));
    const tarList = execFileSync('bsdtar', ['-tf', isoPath], { maxBuffer: 1 << 26 })
      .toString().split('\n').filter(Boolean)
      .map((l) => l.replace(/\/+$/, '').toUpperCase())
      .filter((l) => l && l !== '.');
    const tarFiles = new Set();
    const tarDirs = new Set(tarList); // includes dirs; files = entries not prefixing others
    for (const e of tarList) {
      let isDir = false;
      for (const other of tarList) {
        if (other !== e && other.startsWith(e + '/')) { isDir = true; break; }
      }
      if (!isDir) tarFiles.add(e);
    }
    // note: empty dirs would be misclassified as files by the heuristic; these discs have none
    const missing = [...tarFiles].filter((f) => !ours.has(f));
    const extra = [...ours].filter((f) => !tarFiles.has(f));
    check(`ISO file list matches bsdtar (${ours.size} files)`,
      missing.length === 0 && extra.length === 0,
      `missing=${missing.slice(0, 3)} extra=${extra.slice(0, 3)}`);

    // --- file sizes: spot-check DICOMDIR size vs extracted copy
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const byPath = new Map(root.files.map((f) => [f.path.toUpperCase(), f]));
    const ddEntry = byPath.get('DICOMDIR');
    const extractedDD = path.join(dataDir, disc, 'DICOMDIR');
    if (fs.existsSync(extractedDD)) {
      const st = fs.statSync(extractedDD);
      check('DICOMDIR size matches extracted copy', ddEntry && ddEntry.size === st.size,
        `iso=${ddEntry && ddEntry.size} fs=${st.size}`);
      const bytes = await iso.readFile(ddEntry);
      const ref = fs.readFileSync(extractedDD);
      check('DICOMDIR bytes identical', Buffer.compare(Buffer.from(bytes), ref) === 0);
    }

    // --- DICOMDIR index vs pydicom ground truth
    const ddBytes = await iso.readFile(ddEntry);
    const ddDs = DICOM.parse(ddBytes);
    const index = DICOMDIR.buildIndex(ddDs);
    const gt = GT[disc];
    check('patients count', index.patients.length === gt.patients,
      `${index.patients.length} vs ${gt.patients}`);
    const studies = index.patients.flatMap((p) => p.studies);
    check('studies count', studies.length === gt.studies, `${studies.length} vs ${gt.studies}`);
    const series = studies.flatMap((s) => s.series);
    const images = series.reduce((n, s) => n + s.images.length, 0);
    // ground truth counts include non-image record types' parents; compare per-series
    let seriesMatch = 0, seriesTotal = 0;
    for (const s of series) {
      seriesTotal++;
      if (GT[disc].seriesImages[s.uid] === s.images.length) seriesMatch++;
    }
    check(`series counts match (${seriesTotal} series, ${images} images)`,
      seriesMatch === seriesTotal &&
      Object.keys(gt.seriesImages).filter((k) => gt.seriesImages[k] > 0).length >= seriesTotal,
      `${seriesMatch}/${seriesTotal}`);

    // --- every referenced file resolves on the ISO
    let unresolved = 0;
    for (const s of series) {
      for (const im of s.images) {
        if (!byPath.has(im.fileId.join('/').toUpperCase())) unresolved++;
      }
    }
    check('all DICOMDIR file references resolve', unresolved === 0, `${unresolved} unresolved`);

    // --- decode sample instances, compare pixel stats with pydicom
    for (const sample of GT.samples.filter((s) => s.path.startsWith(disc + '/'))) {
      const rel = sample.path.slice(disc.length + 1).toUpperCase();
      const entry = byPath.get(rel);
      if (!entry) { check(`sample ${rel} found`, false); continue; }
      const bytes = await iso.readFile(entry);
      const ds = DICOM.parse(bytes);
      const px = DICOM.decodePixels(ds, bytes);
      let min = Infinity, max = -Infinity, sum = 0;
      for (let i = 0; i < px.data.length; i++) {
        const v = px.data[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const okDims = px.width === sample.cols && px.height === sample.rows &&
        px.samples === sample.samplesPerPixel;
      const okStats = min === sample.min && max === sample.max && sum === sample.sum;
      check(`decode ${sample.modality}/${sample.photometric} ${rel}`,
        okDims && okStats,
        `dims ${px.width}x${px.height}x${px.samples} vs ${sample.cols}x${sample.rows}x${sample.samplesPerPixel}; ` +
        `min/max/sum ${min}/${max}/${sum} vs ${sample.min}/${sample.max}/${sample.sum}`);
      const slope = ds.number(DICOM.TAGS.RescaleSlope) ?? 1;
      const inter = ds.number(DICOM.TAGS.RescaleIntercept) ?? 0;
      check(`rescale ${rel}`, slope === sample.rescaleSlope && inter === sample.rescaleIntercept,
        `${slope}/${inter} vs ${sample.rescaleSlope}/${sample.rescaleIntercept}`);
    }

    // --- stack ordering vs pydicom for the geometric test series (disc2)
    if (disc === 'disc2' && GT.stackOrder) {
      const files = GT.stackOrder.files;
      const instances = [];
      for (const f of files) {
        const entry = byPath.get(f.toUpperCase());
        const ds = await readHeader(iso, entry);
        instances.push({
          file: f,
          meta: {
            position: ds.numbers(DICOM.TAGS.ImagePositionPatient),
            orientation: ds.numbers(DICOM.TAGS.ImageOrientationPatient),
            sliceLocation: ds.number(DICOM.TAGS.SliceLocation),
            instanceNumber: ds.number(DICOM.TAGS.InstanceNumber),
          },
        });
      }
      // shuffle deterministically, then sort
      instances.sort((a, b) => (a.file.split('/')[2] < b.file.split('/')[2] ? 1 : -1));
      STACK.sortInstances(instances);
      const sortedFiles = instances.map((i) => i.file);
      check('stack order matches pydicom projection sort',
        JSON.stringify(sortedFiles) === JSON.stringify(files),
        `first: ${sortedFiles[0]} vs ${files[0]}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
