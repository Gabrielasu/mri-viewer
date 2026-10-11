/*
 * Application shell: accepts ISO images / DICOM folders / loose DICOM files
 * dropped from Finder, indexes them (DICOMDIR fast path, full scan fallback),
 * and drives the viewport. Everything runs locally in the browser; no data
 * ever leaves the machine.
 */
(function () {
  'use strict';

  const { Iso9660, BlobSource } = window.ISO9660;
  const DICOM = window.DICOM;
  const T = DICOM.TAGS;
  const { Viewport, WINDOW_PRESETS } = window.RENDER;

  /* ---------------- data model ---------------- */

  const model = {
    patients: new Map(),  // patientKey -> {name,id,birthDate,sex, studies: Map}
    seriesByUid: new Map(),
  };

  const decodedCache = new Map(); // cacheKey -> decoded slice
  let decodedCacheBytes = 0;
  const DECODED_CACHE_LIMIT = 384 * 1024 * 1024;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* ---------------- byte access helpers ---------------- */

  async function readRange(src, offset, length) {
    if (src.kind === 'iso') return src.iso.readFile(src.entry, offset, length);
    const end = Math.min(offset + length, src.file.size);
    return new Uint8Array(await src.file.slice(offset, end).arrayBuffer());
  }
  const srcSize = (src) => (src.kind === 'iso' ? src.entry.size : src.file.size);

  /** Parse the DICOM header, growing the read window as needed. */
  async function readHeader(src) {
    const size = srcSize(src);
    const steps = [16384, 131072, 1048576, size];
    for (const n of steps) {
      const want = Math.min(n, size);
      const bytes = await readRange(src, 0, want);
      try {
        const ds = DICOM.parse(bytes);
        if (ds.pixel || want >= size) return ds;
      } catch (e) {
        if (!(e instanceof DICOM.NeedMoreData)) throw e;
        if (want >= size) throw new Error('Truncated DICOM file');
      }
    }
    throw new Error('Could not parse DICOM header');
  }

  /* ---------------- indexing ---------------- */

  function patientKey(id, name) { return `${id}||${name}`; }

  function getPatient(id, name, birthDate, sex) {
    const key = patientKey(id, name);
    if (!model.patients.has(key)) {
      model.patients.set(key, { id, name, birthDate: birthDate || '', sex: sex || '', studies: new Map() });
    }
    return model.patients.get(key);
  }

  function getStudy(patient, uid, date, description) {
    const key = uid || `${date}|${description}`;
    if (!patient.studies.has(key)) {
      patient.studies.set(key, { uid, date: date || '', description: description || '', series: new Map() });
    }
    const st = patient.studies.get(key);
    if (!st.description && description) st.description = description;
    if (!st.date && date) st.date = date;
    return st;
  }

  function getSeries(study, uid, modality, number, description, sourceLabel) {
    const key = uid || `${modality}|${number}|${description}`;
    if (!study.series.has(key)) {
      const s = {
        uid: key, modality: modality || '?', number, description: description || '',
        instances: [], state: 'indexed', sorted: null, thumb: null, sourceLabel, study,
      };
      study.series.set(key, s);
      model.seriesByUid.set(key, s);
    }
    const series = study.series.get(key);
    if (!series.study) series.study = study;
    return series;
  }

  /** Index one ISO image File. */
  async function indexIso(file) {
    setStatus(`Opening ${file.name}…`);
    const iso = await Iso9660.open(new BlobSource(file));
    const root = await iso.readTree();
    const byPath = new Map();
    for (const f of root.files) byPath.set(f.path.toUpperCase(), f);

    const dicomdirEntry = byPath.get('DICOMDIR');
    if (dicomdirEntry) {
      try {
        const bytes = await iso.readFile(dicomdirEntry);
        const index = window.DICOMDIR.buildIndex(DICOM.parse(bytes));
        if (index && index.patients.length) {
          let images = 0;
          for (const p of index.patients) {
            const patient = getPatient(p.id, p.name, p.birthDate, p.sex);
            for (const st of p.studies) {
              const study = getStudy(patient, st.uid, st.date, st.description);
              for (const se of st.series) {
                const series = getSeries(study, se.uid, se.modality, se.number, se.description, file.name);
                for (const im of se.images) {
                  const entry = byPath.get(im.fileId.join('/').toUpperCase());
                  if (!entry) continue;
                  series.instances.push({
                    src: { kind: 'iso', iso, entry },
                    instanceNumber: im.instanceNumber,
                    ds: null, meta: null,
                  });
                  images++;
                }
              }
            }
          }
          if (images > 0) return images;
        }
      } catch (e) {
        console.warn('DICOMDIR parse failed, falling back to scan', e);
      }
    }
    // fallback: scan every file on the disc
    return scanSources(root.files.map((entry) => ({ kind: 'iso', iso, entry })), file.name);
  }

  const SKIP_EXT = /\.(exe|dll|htm|html|jpg|jpeg|png|gif|pdf|inf|txt|xml|ico|chm|xsl|css|js|cfg|config|lic|bat|db|sys|fon|ttf|zip|mp4|avi)$/i;

  /** Scan arbitrary sources for DICOM files and index them by header contents. */
  async function scanSources(sources, label) {
    const candidates = sources.filter((s) => {
      const name = s.kind === 'iso' ? s.entry.name : s.file.name;
      if (SKIP_EXT.test(name)) return false;
      return srcSize(s) >= 200;
    });
    let done = 0, found = 0;
    showProgress(true);
    const workers = Array.from({ length: 8 }, async () => {
      while (candidates.length) {
        const src = candidates.pop();
        done++;
        if (done % 25 === 0) {
          setStatus(`Scanning ${label}: ${done} files, ${found} DICOM images…`);
          setProgress(done / (done + candidates.length));
          await new Promise((r) => setTimeout(r));
        }
        try {
          const head = await readRange(src, 0, 132);
          const isPart10 = head.length >= 132 &&
            head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d;
          if (!isPart10) continue;
          const ds = await readHeader(src);
          if (!ds.pixel) continue; // skip non-image objects (GSPS, SR, ...)
          const patient = getPatient(ds.string(T.PatientID) || '', ds.string(T.PatientName) || 'Unknown',
            ds.string(T.PatientBirthDate), ds.string(T.PatientSex));
          const study = getStudy(patient, ds.string(T.StudyInstanceUID) || '',
            ds.string(T.StudyDate) || '', ds.string(T.StudyDescription) || '');
          const series = getSeries(study, ds.string(T.SeriesInstanceUID) || '',
            ds.string(T.Modality) || '?', ds.number(T.SeriesNumber),
            ds.string(T.SeriesDescription) || '', label);
          series.instances.push({
            src, instanceNumber: ds.number(T.InstanceNumber), ds, meta: null,
          });
          found++;
        } catch (e) { /* not a DICOM file */ }
      }
    });
    await Promise.all(workers);
    showProgress(false);
    return found;
  }

  /* ---------------- series preparation ---------------- */

  function buildMeta(ds) {
    const wcs = ds.numbers(T.WindowCenter);
    const wws = ds.numbers(T.WindowWidth);
    let defaultWindow = null;
    if (wcs.length && wws.length && wws[0] > 0) defaultWindow = { wc: wcs[0], ww: wws[0] };
    return {
      modality: ds.string(T.Modality) || '',
      photometric: ds.string(T.PhotometricInterpretation) || 'MONOCHROME2',
      rescaleSlope: ds.number(T.RescaleSlope) ?? 1,
      rescaleIntercept: ds.number(T.RescaleIntercept) ?? 0,
      pixelSpacing: ds.numbers(T.PixelSpacing),
      orientation: ds.numbers(T.ImageOrientationPatient),
      position: ds.numbers(T.ImagePositionPatient),
      sliceLocation: ds.number(T.SliceLocation),
      sliceThickness: ds.number(T.SliceThickness),
      instanceNumber: ds.number(T.InstanceNumber),
      defaultWindow,
      windowOptions: wcs.map((wc, i) => ({ wc, ww: wws[i] })).filter((w) => w.ww > 0),
      rows: ds.number(T.Rows), cols: ds.number(T.Columns),
      seriesDescription: ds.string(T.SeriesDescription) || '',
      studyDescription: ds.string(T.StudyDescription) || '',
      studyDate: ds.string(T.StudyDate) || '',
      patientName: ds.string(T.PatientName) || '',
      patientId: ds.string(T.PatientID) || '',
      acquisitionDate: ds.string(T.AcquisitionDate) || '',
    };
  }

  /** Load headers for every instance of a series and sort into a stack. */
  async function prepareSeries(series) {
    if (series.state === 'ready') return;
    if (series.prepPromise) return series.prepPromise;
    series.prepPromise = (async () => {
      const todo = series.instances.filter((i) => !i.ds);
      let done = 0;
      if (todo.length) {
        showProgress(true);
        const queue = todo.slice();
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (queue.length) {
            const inst = queue.pop();
            try { inst.ds = await readHeader(inst.src); }
            catch (e) { inst.error = String(e); }
            done++;
            if (done % 20 === 0) {
              setStatus(`Loading series: ${done}/${todo.length}`);
              setProgress(done / todo.length);
              await new Promise((r) => setTimeout(r));
            }
          }
        }));
        showProgress(false);
      }
      const ok = series.instances.filter((i) => i.ds && i.ds.pixel);
      for (const inst of ok) inst.meta = buildMeta(inst.ds);
      series.sorted = window.STACK.sortInstances(ok);
      series.state = 'ready';
    })();
    try { await series.prepPromise; } finally { series.prepPromise = null; }
  }

  /* ---------------- slice decoding & cache ---------------- */

  function cacheBytes(decoded) { return decoded.pixels.data.byteLength + 256; }

  function cachePut(key, value) {
    if (decodedCache.has(key)) return;
    decodedCache.set(key, value);
    decodedCacheBytes += cacheBytes(value);
    while (decodedCacheBytes > DECODED_CACHE_LIMIT && decodedCache.size > 4) {
      const [k, v] = decodedCache.entries().next().value;
      decodedCache.delete(k);
      decodedCacheBytes -= cacheBytes(v);
    }
  }

  async function getDecodedSlice(series, index) {
    const key = `${series.uid}#${index}`;
    if (decodedCache.has(key)) {
      const v = decodedCache.get(key);
      decodedCache.delete(key); decodedCache.set(key, v); // LRU bump
      return v;
    }
    const inst = series.sorted[index];
    if (!inst) throw new Error('no such slice');
    const bytes = await readRange(inst.src, 0, srcSize(inst.src));
    const ds = DICOM.parse(bytes);
    const pixels = DICOM.decodePixels(ds, bytes);
    const meta = inst.meta || buildMeta(ds);
    if (!meta.defaultWindow) meta.defaultWindow = autoWindow(pixels, meta);
    const decoded = { pixels, meta };
    cachePut(key, decoded);
    return decoded;
  }

  /** Percentile-based fallback window for files without WC/WW. */
  function autoWindow(pixels, meta) {
    if (pixels.samples === 3) return { wc: 128, ww: 256 };
    const d = pixels.data;
    const stride = Math.max(1, Math.floor(d.length / 50000));
    const sample = [];
    for (let i = 0; i < d.length; i += stride) sample.push(d[i]);
    sample.sort((a, b) => a - b);
    const lo = sample[Math.floor(sample.length * 0.01)];
    const hi = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.99))];
    const s = meta.rescaleSlope, b = meta.rescaleIntercept;
    const vlo = lo * s + b, vhi = hi * s + b;
    return { wc: (vlo + vhi) / 2, ww: Math.max(1, vhi - vlo) };
  }

  /* ---------------- full-series PNG export ---------------- */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  function zipHeader(size, fill) {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    return bytes;
  }

  /** Build a ZIP using stored entries. PNG data is already compressed. */
  class ZipBuilder {
    constructor() {
      this.parts = [];
      this.entries = [];
      this.offset = 0;
      this.encoder = new TextEncoder();
    }

    async add(name, blob) {
      const nameBytes = this.encoder.encode(name);
      const data = new Uint8Array(await blob.arrayBuffer());
      const crc = crc32(data);
      const size = blob.size;
      const stamp = dosDateTime(new Date());
      const localOffset = this.offset;
      const header = zipHeader(30, (v) => {
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 0x0800, true); // UTF-8 filename
        v.setUint16(8, 0, true);      // stored; PNG itself is compressed
        v.setUint16(10, stamp.time, true);
        v.setUint16(12, stamp.date, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, size, true);
        v.setUint32(22, size, true);
        v.setUint16(26, nameBytes.length, true);
      });
      this.parts.push(header, nameBytes, blob);
      this.offset += header.length + nameBytes.length + size;
      this.entries.push({ nameBytes, crc, size, stamp, localOffset });
    }

    finish() {
      if (this.entries.length > 0xffff || this.offset >= 0xffffffff) {
        throw new Error('This series is too large for a browser ZIP export');
      }
      const centralOffset = this.offset;
      const central = [];
      let centralSize = 0;
      for (const entry of this.entries) {
        const header = zipHeader(46, (v) => {
          v.setUint32(0, 0x02014b50, true);
          v.setUint16(4, 20, true);
          v.setUint16(6, 20, true);
          v.setUint16(8, 0x0800, true);
          v.setUint16(10, 0, true);
          v.setUint16(12, entry.stamp.time, true);
          v.setUint16(14, entry.stamp.date, true);
          v.setUint32(16, entry.crc, true);
          v.setUint32(20, entry.size, true);
          v.setUint32(24, entry.size, true);
          v.setUint16(28, entry.nameBytes.length, true);
          v.setUint32(42, entry.localOffset, true);
        });
        central.push(header, entry.nameBytes);
        centralSize += header.length + entry.nameBytes.length;
      }
      const end = zipHeader(22, (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, this.entries.length, true);
        v.setUint16(10, this.entries.length, true);
        v.setUint32(12, centralSize, true);
        v.setUint32(16, centralOffset, true);
      });
      return new Blob([...this.parts, ...central, end], { type: 'application/zip' });
    }
  }

  /** Disk-backed ZIP writer for very large all-scan exports. */
  class StreamingZipBuilder {
    constructor(writable) {
      this.writable = writable;
      this.entries = [];
      this.offset = 0;
      this.encoder = new TextEncoder();
      this.closed = false;
    }

    async add(name, blob) {
      const nameBytes = this.encoder.encode(name);
      const data = new Uint8Array(await blob.arrayBuffer());
      const crc = crc32(data);
      const size = blob.size;
      const stamp = dosDateTime(new Date());
      const localOffset = this.offset;
      if (localOffset + 30 + nameBytes.length + size >= 0xffffffff) {
        throw new Error('The export is larger than the 4 GB ZIP limit');
      }
      const header = zipHeader(30, (v) => {
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 0x0800, true);
        v.setUint16(8, 0, true);
        v.setUint16(10, stamp.time, true);
        v.setUint16(12, stamp.date, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, size, true);
        v.setUint32(22, size, true);
        v.setUint16(26, nameBytes.length, true);
      });
      await this.writable.write(header);
      await this.writable.write(nameBytes);
      await this.writable.write(blob);
      this.offset += header.length + nameBytes.length + size;
      this.entries.push({ nameBytes, crc, size, stamp, localOffset });
    }

    async finish() {
      if (this.entries.length > 0xffff) throw new Error('The export contains too many files for a ZIP archive');
      const centralOffset = this.offset;
      let centralSize = 0;
      for (const entry of this.entries) {
        const header = zipHeader(46, (v) => {
          v.setUint32(0, 0x02014b50, true);
          v.setUint16(4, 20, true);
          v.setUint16(6, 20, true);
          v.setUint16(8, 0x0800, true);
          v.setUint16(10, 0, true);
          v.setUint16(12, entry.stamp.time, true);
          v.setUint16(14, entry.stamp.date, true);
          v.setUint32(16, entry.crc, true);
          v.setUint32(20, entry.size, true);
          v.setUint32(24, entry.size, true);
          v.setUint16(28, entry.nameBytes.length, true);
          v.setUint32(42, entry.localOffset, true);
        });
        await this.writable.write(header);
        await this.writable.write(entry.nameBytes);
        centralSize += header.length + entry.nameBytes.length;
      }
      const end = zipHeader(22, (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, this.entries.length, true);
        v.setUint16(10, this.entries.length, true);
        v.setUint32(12, centralSize, true);
        v.setUint32(16, centralOffset, true);
      });
      await this.writable.write(end);
      await this.writable.close();
      this.closed = true;
      return null;
    }

    async abort() {
      if (!this.closed) {
        await this.writable.abort();
        this.closed = true;
      }
    }
  }

  function pngBlobForSlice(decoded, wc, ww, invert) {
    const { pixels, meta } = decoded;
    const canvas = document.createElement('canvas');
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(pixels.width, pixels.height);
    const out = image.data;
    const count = pixels.width * pixels.height;
    if (pixels.samples === 3) {
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        out[j] = pixels.data[i * 3];
        out[j + 1] = pixels.data[i * 3 + 1];
        out[j + 2] = pixels.data[i * 3 + 2];
        out[j + 3] = 255;
      }
    } else {
      const center = wc - 0.5;
      const width = Math.max(1, ww - 1);
      const flip = (meta.photometric === 'MONOCHROME1') !== invert;
      const slope = meta.rescaleSlope;
      const intercept = meta.rescaleIntercept;
      for (let i = 0, j = 0; i < count; i++, j += 4) {
        const value = pixels.data[i] * slope + intercept;
        let y = ((value - center) / width + 0.5) * 255;
        y = y < 0 ? 0 : y > 255 ? 255 : y;
        if (flip) y = 255 - y;
        out[j] = y; out[j + 1] = y; out[j + 2] = y; out[j + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('Could not encode PNG')),
      'image/png',
    ));
  }

  function safeFileName(value, fallback) {
    const clean = (value || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
    return clean || fallback;
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  let exportingSeries = false;
  function setBatchExportDisabled(disabled) {
    for (const id of ['#btn-export-series', '#btn-export-study', '#btn-export-all']) {
      const button = $(id);
      if (button) button.disabled = disabled;
    }
  }

  async function exportSeries() {
    if (exportingSeries || !current.series || !viewport.slice) return;
    exportingSeries = true;
    stopCine();
    setBatchExportDisabled(true);
    const series = current.series;
    const wc = viewport.wc;
    const ww = viewport.ww;
    const invert = viewport.invert;
    const total = series.sorted.length;
    const digits = Math.max(4, String(total).length);
    const base = safeFileName(series.description, `${series.modality || 'scan'}_series`);
    const zip = new ZipBuilder();
    let exported = 0;
    let skipped = 0;
    showProgress(true);
    try {
      for (let i = 0; i < total; i++) {
        setStatus(`Exporting ${base}: ${i + 1}/${total}…`);
        setProgress(i / total);
        try {
          const decoded = await getDecodedSlice(series, i);
          const png = await pngBlobForSlice(decoded, wc, ww, invert);
          const name = `${base}/slice_${String(i + 1).padStart(digits, '0')}.png`;
          await zip.add(name, png);
          exported++;
        } catch (e) {
          if (/compressed pixel data/i.test(String(e && (e.message || e)))) throw e;
          skipped++;
        }
        if (i % 3 === 2) await new Promise((resolve) => setTimeout(resolve));
      }
      if (!exported) throw new Error('No slices could be exported');
      setStatus(`Preparing ZIP with ${exported} slices…`);
      setProgress(1);
      const archive = zip.finish();
      downloadBlob(archive, `${base}_${exported}_slices.zip`);
      setStatus(`Exported ${exported} slices${skipped ? ` (${skipped} skipped)` : ''}.`);
    } catch (e) {
      setStatus(`Series export failed: ${e.message || e}`);
    } finally {
      showProgress(false);
      setBatchExportDisabled(false);
      exportingSeries = false;
    }
  }

  function findStudyForSeries(target) {
    if (target && target.study) return target.study;
    for (const patient of model.patients.values()) {
      for (const study of patient.studies.values()) {
        if ([...study.series.values()].includes(target)) return study;
      }
    }
    return null;
  }

  function loadedStudies() {
    const studies = [];
    for (const patient of model.patients.values()) studies.push(...patient.studies.values());
    return studies.sort((a, b) => {
      const dateOrder = (a.date || '').localeCompare(b.date || '');
      return dateOrder || (a.description || '').localeCompare(b.description || '');
    });
  }

  /** Export one or more studies, with nested scan and series folders. */
  async function exportStudies(studies, allScans) {
    if (exportingSeries || !studies.length) return;
    exportingSeries = true;
    stopCine();
    setBatchExportDisabled(true);
    let zip = null;
    let completed = false;
    const tasks = [];
    for (let studyIndex = 0; studyIndex < studies.length; studyIndex++) {
      const study = studies[studyIndex];
      const scanNumber = String(studyIndex + 1).padStart(Math.max(2, String(studies.length).length), '0');
      const studyName = safeFileName(
        [study.date, study.description].filter(Boolean).join('_'),
        `scan_${scanNumber}`,
      );
      const studyFolder = allScans ? `all_scans/${scanNumber}_${studyName}` : studyName;
      const seriesList = [...study.series.values()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
      for (let seriesIndex = 0; seriesIndex < seriesList.length; seriesIndex++) {
        tasks.push({ study, studyIndex, studyFolder, series: seriesList[seriesIndex], seriesIndex, seriesCount: seriesList.length });
      }
    }
    let exported = 0;
    let skipped = 0;
    let exportedSeries = 0;
    const exportedStudies = new Set();
    showProgress(true);
    try {
      if (allScans && typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'all_scans.zip',
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        });
        zip = new StreamingZipBuilder(await handle.createWritable());
      } else {
        zip = new ZipBuilder();
      }
      // DICOMDIR entries may not have loaded their image headers yet. Prepare
      // every series first so progress reflects the real number of slices.
      for (let i = 0; i < tasks.length; i++) {
        setStatus(`Preparing series ${i + 1}/${tasks.length}…`);
        await prepareSeries(tasks[i].series);
      }
      const total = tasks.reduce((sum, task) => sum + task.series.sorted.length, 0);
      if (!total) throw new Error('The selected scans have no viewable slices');
      showProgress(true);
      let processed = 0;
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        const task = tasks[taskIndex];
        const series = task.series;
        if (!series.sorted.length) continue;
        const prefix = String(task.seriesIndex + 1).padStart(Math.max(2, String(task.seriesCount).length), '0');
        const folder = safeFileName(
          `${prefix}_${series.modality || 'scan'}_${series.description || `series_${series.number ?? task.seriesIndex + 1}`}`,
          `${prefix}_series`,
        );
        const digits = Math.max(4, String(series.sorted.length).length);
        const isCurrent = series === current.series && viewport && viewport.slice;
        let seriesWindow = isCurrent ? { wc: viewport.wc, ww: viewport.ww } : null;
        const invert = isCurrent ? viewport.invert : false;
        let unsupported = false;
        let seriesExported = 0;
        for (let i = 0; i < series.sorted.length; i++) {
          setStatus(`Exporting scan ${task.studyIndex + 1}/${studies.length}, series ${task.seriesIndex + 1}/${task.seriesCount}, slice ${i + 1}/${series.sorted.length}…`);
          setProgress(processed / total);
          try {
            const decoded = await getDecodedSlice(series, i);
            if (!seriesWindow) seriesWindow = decoded.meta.defaultWindow || autoWindow(decoded.pixels, decoded.meta);
            const png = await pngBlobForSlice(decoded, seriesWindow.wc, seriesWindow.ww, invert);
            const name = `${task.studyFolder}/${folder}/slice_${String(i + 1).padStart(digits, '0')}.png`;
            await zip.add(name, png);
            exported++;
            seriesExported++;
          } catch (e) {
            if (/compressed pixel data/i.test(String(e && (e.message || e)))) {
              skipped += series.sorted.length - i;
              processed += series.sorted.length - i;
              unsupported = true;
              break;
            }
            skipped++;
          }
          processed++;
          if (processed % 3 === 0) await new Promise((resolve) => setTimeout(resolve));
        }
        if (seriesExported) {
          exportedSeries++;
          exportedStudies.add(task.study);
        }
        if (unsupported) continue;
      }
      if (!exported) throw new Error('No slices could be exported');
      setStatus(`Preparing ZIP with ${exported} slices in ${exportedSeries} series…`);
      setProgress(1);
      const archive = await zip.finish();
      completed = true;
      const singleStudyName = tasks.length ? tasks[0].studyFolder : 'scan';
      const archiveName = allScans ? 'all_scans' : safeFileName(singleStudyName, 'scan');
      if (archive) downloadBlob(archive, `${archiveName}_${exported}_slices.zip`);
      const skippedText = skipped ? `; ${skipped} slices skipped` : '';
      setStatus(`Exported ${exported} slices from ${exportedStudies.size} scan${exportedStudies.size === 1 ? '' : 's'} in ${exportedSeries} series${skippedText}.`);
    } catch (e) {
      if (e && e.name === 'AbortError') setStatus('Export canceled.');
      else setStatus(`${allScans ? 'All-scans' : 'Scan'} export failed: ${e.message || e}`);
    } finally {
      if (zip && !completed && typeof zip.abort === 'function') {
        try { await zip.abort(); } catch (e) { /* best-effort cleanup */ }
      }
      showProgress(false);
      setBatchExportDisabled(false);
      exportingSeries = false;
    }
  }

  /** Export the study containing the selected series, one folder per series. */
  async function exportStudy() {
    if (!current.series) return;
    const study = findStudyForSeries(current.series);
    if (!study) { setStatus('Could not identify the current scan.'); return; }
    await exportStudies([study], false);
  }

  /** Export every study currently indexed from all opened files. */
  async function exportAllStudies() {
    const studies = loadedStudies();
    if (!studies.length) { setStatus('Open one or more scans before exporting.'); return; }
    await exportStudies(studies, true);
  }

  /* ---------------- viewer state ---------------- */

  let viewport = null;
  let current = { series: null, index: 0 };
  let cine = { playing: false, timer: 0, fps: 12 };
  let loadToken = 0;

  async function openSeries(series, index) {
    stopCine();
    setStatus(`Opening ${series.description || 'series'}…`);
    try {
      await prepareSeries(series);
    } catch (e) {
      setStatus(`Failed to load series: ${e.message || e}`);
      return;
    }
    if (!series.sorted.length) { setStatus('Series has no viewable images.'); return; }
    current.series = series;
    current.index = index != null ? index : Math.floor(series.sorted.length / 2);
    document.body.classList.add('has-image');
    await showSlice(current.index, false);
    updateSidebarSelection();
    updatePresetMenu();
    setStatus('');
  }

  async function showSlice(index, keepView = true) {
    const series = current.series;
    if (!series) return;
    index = Math.max(0, Math.min(series.sorted.length - 1, index));
    current.index = index;
    const token = ++loadToken;
    let decoded;
    try {
      decoded = await getDecodedSlice(series, index);
    } catch (e) {
      setStatus(`Failed to decode slice: ${e.message || e}`);
      return;
    }
    if (token !== loadToken) return; // superseded by a newer request
    if (viewport.wcInitFor !== series.uid) {
      const w = decoded.meta.defaultWindow || { wc: 40, ww: 400 };
      viewport.wc = w.wc; viewport.ww = w.ww;
      viewport.wcInitFor = series.uid;
      viewport.lutKey = '';
    }
    viewport.setSlice(decoded, `${series.uid}#${index}`, keepView);
    updateOverlay(decoded.meta);
    updateSliceUI();
    prefetch(series, index);
  }

  function prefetch(series, index) {
    for (const d of [1, -1, 2, -2, 3]) {
      const i = index + d;
      if (i >= 0 && i < series.sorted.length && !decodedCache.has(`${series.uid}#${i}`)) {
        getDecodedSlice(series, i).catch(() => {});
      }
    }
  }

  function updateOverlay(meta) {
    const s = current.series;
    viewport.overlay = {
      topLeft: [
        meta.patientName.replace(/\^/g, ' '),
        meta.patientId ? `ID: ${meta.patientId}` : '',
        meta.studyDescription,
      ],
      topRight: [
        fmtDate(meta.studyDate),
        `${s.modality} ${s.number != null ? '#' + s.number : ''}`,
        meta.seriesDescription,
      ],
      bottomLeft: [
        `Slice ${current.index + 1}/${s.sorted.length}`,
        meta.sliceThickness ? `Thk ${meta.sliceThickness.toFixed(1)} mm` : '',
        meta.sliceLocation != null ? `Loc ${meta.sliceLocation.toFixed(1)}` : '',
      ],
      bottomRight: [
        `W ${Math.round(viewport.ww)} / L ${Math.round(viewport.wc)}`,
        `Zoom ${(viewport.zoom * 100).toFixed(0)}%`,
      ],
    };
    viewport.requestRender();
  }

  function updateSliceUI() {
    const s = current.series;
    const slider = $('#slice-slider');
    slider.max = String(Math.max(0, s.sorted.length - 1));
    slider.value = String(current.index);
    $('#slice-label').textContent = `${current.index + 1} / ${s.sorted.length}`;
  }

  function fmtDate(d) {
    if (!d || d.length !== 8) return d || '';
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  /* ---------------- sidebar UI ---------------- */

  function renderSidebar() {
    const box = $('#series-list');
    box.textContent = '';
    for (const patient of model.patients.values()) {
      const pEl = el('div', 'patient');
      pEl.append(el('div', 'patient-name',
        `${patient.name.replace(/\^/g, ' ')}${patient.id ? ' · ' + patient.id : ''}`));
      const studies = [...patient.studies.values()].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      for (const study of studies) {
        const stEl = el('details', 'study');
        const sum = el('summary');
        const count = [...study.series.values()].reduce((n, s) => n + s.instances.length, 0);
        sum.append(
          el('span', 'study-title', study.description || 'Study'),
          el('span', 'study-meta', `${fmtDate(study.date)} · ${study.series.size} series · ${count} img`),
        );
        stEl.append(sum);
        const list = el('div', 'series-cards');
        const seriesArr = [...study.series.values()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
        for (const series of seriesArr) {
          const card = el('div', 'series-card');
          card.dataset.uid = series.uid;
          const thumb = el('div', 'thumb');
          if (series.thumb) {
            const img = el('img'); img.src = series.thumb; thumb.append(img);
          } else {
            thumb.append(el('span', 'thumb-modality', series.modality));
          }
          const info = el('div', 'series-info');
          info.append(
            el('div', 'series-desc', series.description || `Series ${series.number ?? ''}`),
            el('div', 'series-meta',
              `${series.modality}${series.number != null ? ' #' + series.number : ''} · ${series.instances.length} img`),
          );
          card.append(thumb, info);
          card.addEventListener('click', () => openSeries(series));
          list.append(card);
        }
        stEl.append(list);
        stEl.addEventListener('toggle', () => { if (stEl.open) queueThumbs([...study.series.values()]); });
        pEl.append(stEl);
      }
      box.append(pEl);
    }
    // open first study by default
    const first = box.querySelector('details');
    if (first && !box.dataset.opened) { first.open = true; box.dataset.opened = '1'; }
  }

  function updateSidebarSelection() {
    for (const c of document.querySelectorAll('.series-card')) {
      c.classList.toggle('active', current.series && c.dataset.uid === current.series.uid);
    }
  }

  /* thumbnails */
  const thumbQueue = [];
  let thumbRunning = false;
  function queueThumbs(seriesList) {
    for (const s of seriesList) if (!s.thumb && !s.thumbQueued) { s.thumbQueued = true; thumbQueue.push(s); }
    runThumbs();
  }
  async function runThumbs() {
    if (thumbRunning) return;
    thumbRunning = true;
    while (thumbQueue.length) {
      const series = thumbQueue.shift();
      try {
        const mid = series.instances[Math.floor(series.instances.length / 2)];
        const bytes = await readRange(mid.src, 0, srcSize(mid.src));
        const ds = DICOM.parse(bytes);
        const pixels = DICOM.decodePixels(ds, bytes);
        const meta = buildMeta(ds);
        series.thumb = makeThumb(pixels, meta);
        const card = document.querySelector(`.series-card[data-uid="${CSS.escape(series.uid)}"] .thumb`);
        if (card) {
          card.textContent = '';
          const img = el('img'); img.src = series.thumb; card.append(img);
        }
      } catch (e) { /* leave placeholder */ }
      await new Promise((r) => setTimeout(r));
    }
    thumbRunning = false;
  }

  function makeThumb(pixels, meta) {
    const size = 72;
    const c = document.createElement('canvas');
    const full = document.createElement('canvas');
    full.width = pixels.width; full.height = pixels.height;
    const fctx = full.getContext('2d');
    const img = fctx.createImageData(pixels.width, pixels.height);
    const out = img.data;
    if (pixels.samples === 3) {
      for (let i = 0, j = 0; i < pixels.width * pixels.height; i++, j += 4) {
        out[j] = pixels.data[i * 3]; out[j + 1] = pixels.data[i * 3 + 1]; out[j + 2] = pixels.data[i * 3 + 2]; out[j + 3] = 255;
      }
    } else {
      const w = meta.defaultWindow || autoWindowStatic(pixels, meta);
      const wc = w.wc - 0.5, ww = Math.max(1, w.ww - 1);
      const mono1 = meta.photometric === 'MONOCHROME1';
      const s = meta.rescaleSlope, b = meta.rescaleIntercept;
      for (let i = 0, j = 0; i < pixels.width * pixels.height; i++, j += 4) {
        const v = pixels.data[i] * s + b;
        let y = ((v - wc) / ww + 0.5) * 255;
        y = y < 0 ? 0 : y > 255 ? 255 : y;
        if (mono1) y = 255 - y;
        out[j] = y; out[j + 1] = y; out[j + 2] = y; out[j + 3] = 255;
      }
    }
    fctx.putImageData(img, 0, 0);
    const aspect = pixels.height / pixels.width;
    c.width = size; c.height = Math.max(24, Math.round(size * aspect));
    const ctx = c.getContext('2d');
    ctx.drawImage(full, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }
  function autoWindowStatic(pixels, meta) { return autoWindow(pixels, meta); }

  /* ---------------- status ---------------- */

  function setStatus(text) { $('#status-text').textContent = text; }
  function showProgress(on) { $('#progress').classList.toggle('hidden', !on); if (!on) setProgress(0); }
  function setProgress(f) { $('#progress-bar').style.width = `${Math.round(f * 100)}%`; }

  /* ---------------- file intake ---------------- */

  async function handleFiles(files) {
    const isoFiles = [], plainFiles = [];
    for (const f of files) {
      if (await looksLikeIso(f)) isoFiles.push(f);
      else plainFiles.push(f);
    }
    let total = 0;
    for (const f of isoFiles) {
      try {
        total += await indexIso(f);
      } catch (e) {
        console.error(e);
        setStatus(`Could not read ${f.name}: ${e.message || e}`);
      }
    }
    if (plainFiles.length) {
      total += await scanSources(plainFiles.map((file) => ({ kind: 'file', file })), 'files');
    }
    finishIntake(total);
  }

  function finishIntake(total) {
    if (total > 0) {
      document.body.classList.add('has-data');
      renderSidebar();
      setStatus(`Indexed ${total} images.`);
      // auto-open the first series of the first study
      const firstPatient = model.patients.values().next().value;
      if (firstPatient && !current.series) {
        const firstStudy = [...firstPatient.studies.values()].sort((a, b) => (a.date || '').localeCompare(b.date || ''))[0];
        const seriesArr = [...firstStudy.series.values()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
        if (seriesArr.length) openSeries(seriesArr[0]);
        queueThumbs(seriesArr);
      }
    } else {
      setStatus('No DICOM images found in the dropped items.');
    }
  }

  async function looksLikeIso(file) {
    if (file.size < 17 * 2048 + 6) return false;
    if (/\.(iso|img)$/i.test(file.name)) return true;
    const probe = new Uint8Array(await file.slice(16 * 2048, 16 * 2048 + 6).arrayBuffer());
    return probe[1] === 0x43 && probe[2] === 0x44 && probe[3] === 0x30 && probe[4] === 0x30 && probe[5] === 0x31;
  }

  /** Recursively collect File objects from a drop (supports folders). */
  async function collectDropped(dataTransfer) {
    const out = [];
    const items = [...dataTransfer.items];
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    const walk = async (entry) => {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    if (entries.some(Boolean)) {
      for (const e of entries) await walk(e);
    } else {
      out.push(...dataTransfer.files);
    }
    return out;
  }

  /* ---------------- cine ---------------- */

  function startCine() {
    if (!current.series || cine.playing) return;
    cine.playing = true;
    $('#btn-play').textContent = '⏸';
    const step = () => {
      if (!cine.playing) return;
      const n = current.series.sorted.length;
      showSlice((current.index + 1) % n);
      cine.timer = setTimeout(step, 1000 / cine.fps);
    };
    step();
  }
  function stopCine() {
    cine.playing = false;
    clearTimeout(cine.timer);
    const b = $('#btn-play'); if (b) b.textContent = '▶';
  }

  /* ---------------- toolbar / events ---------------- */

  function updatePresetMenu() {
    const sel = $('#preset-select');
    sel.textContent = '';
    sel.append(new Option('Window preset…', ''));
    const s = current.series;
    if (!s) return;
    const fromFile = s.sorted && s.sorted[0] && s.sorted[0].meta.windowOptions || [];
    fromFile.forEach((w, i) => sel.append(new Option(`File ${i + 1}: L${Math.round(w.wc)} W${Math.round(w.ww)}`, `f${i}`)));
    const presets = WINDOW_PRESETS[s.modality] || [];
    presets.forEach((p, i) => sel.append(new Option(`${p.name} (L${p.wc} W${p.ww})`, `p${i}`)));
    sel.append(new Option('Auto (from pixels)', 'auto'));
  }

  function bindUI() {
    viewport = new Viewport($('#view-canvas'), {
      onSliceRequest: (delta) => showSlice(current.index + delta),
      onStateChange: () => { if (current.series && viewport.slice) updateOverlay(viewport.slice.meta); },
      onProbe: (info) => { $('#probe-text').textContent = info ? info.text : ''; },
    });
    new ResizeObserver(() => viewport.resize()).observe($('#view-canvas'));
    viewport.resize();

    // drag & drop
    const dropOverlay = $('#drop-overlay');
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropOverlay.classList.add('visible'); });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove('visible'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.classList.remove('visible');
      const files = await collectDropped(e.dataTransfer);
      if (files.length) await handleFiles(files);
    });

    $('#file-input').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) await handleFiles(files);
    });
    for (const id of ['#btn-open', '#welcome-open']) {
      $(id).addEventListener('click', () => $('#file-input').click());
    }

    // tools
    for (const btn of document.querySelectorAll('[data-tool]')) {
      btn.addEventListener('click', () => {
        viewport.setTool(btn.dataset.tool);
        for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b === btn);
      });
    }
    $('#btn-invert').addEventListener('click', () => viewport.setInvert(!viewport.invert));
    $('#btn-reset').addEventListener('click', () => { viewport.reset(); if (viewport.slice) updateOverlay(viewport.slice.meta); });
    $('#btn-clear-measure').addEventListener('click', () => viewport.clearMeasurements());
    $('#btn-play').addEventListener('click', () => (cine.playing ? stopCine() : startCine()));
    $('#fps').addEventListener('input', (e) => { cine.fps = +e.target.value; $('#fps-label').textContent = `${cine.fps} fps`; });

    $('#preset-select').addEventListener('change', (e) => {
      const v = e.target.value;
      e.target.value = '';
      const s = current.series;
      if (!s || !viewport.slice) return;
      if (v === 'auto') {
        const w = autoWindow(viewport.slice.pixels, viewport.slice.meta);
        viewport.setWindow(w.wc, w.ww);
      } else if (v.startsWith('f')) {
        const w = s.sorted[0].meta.windowOptions[+v.slice(1)];
        if (w) viewport.setWindow(w.wc, w.ww);
      } else if (v.startsWith('p')) {
        const p = (WINDOW_PRESETS[s.modality] || [])[+v.slice(1)];
        if (p) viewport.setWindow(p.wc, p.ww);
      }
      updateOverlay(viewport.slice.meta);
    });

    $('#slice-slider').addEventListener('input', (e) => showSlice(+e.target.value));

    $('#btn-export').addEventListener('click', () => {
      if (!viewport.slice) return;
      const a = document.createElement('a');
      const s = current.series;
      a.download = `${(s.description || 'slice').replace(/[^\w-]+/g, '_')}_${current.index + 1}.png`;
      a.href = viewport.canvas.toDataURL('image/png');
      a.click();
    });
    $('#btn-export-series').addEventListener('click', exportSeries);
    $('#btn-export-study').addEventListener('click', exportStudy);
    $('#btn-export-all').addEventListener('click', exportAllStudies);

    $('#btn-help').addEventListener('click', () => $('#help-overlay').classList.toggle('hidden'));
    $('#help-overlay').addEventListener('click', () => $('#help-overlay').classList.add('hidden'));

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const s = current.series;
      if (!s) return;
      switch (e.key) {
        case 'ArrowDown': case 'ArrowRight': e.preventDefault(); showSlice(current.index + 1); break;
        case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); showSlice(current.index - 1); break;
        case 'PageDown': e.preventDefault(); showSlice(current.index + 10); break;
        case 'PageUp': e.preventDefault(); showSlice(current.index - 10); break;
        case 'Home': e.preventDefault(); showSlice(0); break;
        case 'End': e.preventDefault(); showSlice(s.sorted.length - 1); break;
        case '+': case '=': viewport._zoomAt(viewport.canvas.getBoundingClientRect().width / 2, viewport.canvas.getBoundingClientRect().height / 2, 1.25); break;
        case '-': viewport._zoomAt(viewport.canvas.getBoundingClientRect().width / 2, viewport.canvas.getBoundingClientRect().height / 2, 0.8); break;
        case '0': viewport.fit(); break;
        case 'i': viewport.setInvert(!viewport.invert); break;
        case 'r': viewport.reset(); if (viewport.slice) updateOverlay(viewport.slice.meta); break;
        case 'p': cine.playing ? stopCine() : startCine(); break;
        case 'c': viewport.clearMeasurements(); break;
        case '1': case '2': case '3': case '4': {
          const tools = ['wl', 'pan', 'zoom', 'measure'];
          const t = tools[+e.key - 1];
          viewport.setTool(t);
          for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
          break;
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', bindUI);

  // automation hook for the e2e test harness
  window.__test = {
    handleFiles,
    model,
    getCurrent: () => current,
    getViewport: () => viewport,
    openSeries,
    showSlice,
  };
})();
