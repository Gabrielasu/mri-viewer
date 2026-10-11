/*
 * Minimal DICOM parser for uncompressed little-endian transfer syntaxes
 * (Implicit VR LE 1.2.840.10008.1.2, Explicit VR LE 1.2.840.10008.1.2.1,
 * Explicit VR BE 1.2.840.10008.1.2.2 for metadata). Compressed/encapsulated
 * pixel data is detected and flagged unsupported rather than decoded.
 *
 * Designed for progressive reads: parse() over a partial buffer throws
 * NeedMoreData when the buffer ends mid-header, so callers can re-read a
 * larger window. Once the PixelData element header is reached, its offset
 * and length are recorded without requiring the pixel bytes themselves.
 */
(function (global) {
  'use strict';

  const TS = {
    IMPLICIT_LE: '1.2.840.10008.1.2',
    EXPLICIT_LE: '1.2.840.10008.1.2.1',
    EXPLICIT_BE: '1.2.840.10008.1.2.2',
  };

  const TAGS = {
    SpecificCharacterSet: 0x00080005,
    ImageType: 0x00080008,
    SOPClassUID: 0x00080016,
    SOPInstanceUID: 0x00080018,
    StudyDate: 0x00080020,
    SeriesDate: 0x00080021,
    AcquisitionDate: 0x00080022,
    StudyTime: 0x00080030,
    Modality: 0x00080060,
    Manufacturer: 0x00080070,
    InstitutionName: 0x00080080,
    StudyDescription: 0x00081030,
    SeriesDescription: 0x0008103e,
    PatientName: 0x00100010,
    PatientID: 0x00100020,
    PatientBirthDate: 0x00100030,
    PatientSex: 0x00100040,
    SliceThickness: 0x00180050,
    SpacingBetweenSlices: 0x00180088,
    ProtocolName: 0x00181030,
    StudyInstanceUID: 0x0020000d,
    SeriesInstanceUID: 0x0020000e,
    StudyID: 0x00200010,
    SeriesNumber: 0x00200011,
    AcquisitionNumber: 0x00200012,
    InstanceNumber: 0x00200013,
    ImagePositionPatient: 0x00200032,
    ImageOrientationPatient: 0x00200037,
    FrameOfReferenceUID: 0x00200052,
    SliceLocation: 0x00201041,
    SamplesPerPixel: 0x00280002,
    PhotometricInterpretation: 0x00280004,
    PlanarConfiguration: 0x00280006,
    NumberOfFrames: 0x00280008,
    Rows: 0x00280010,
    Columns: 0x00280011,
    PixelSpacing: 0x00280030,
    BitsAllocated: 0x00280100,
    BitsStored: 0x00280101,
    HighBit: 0x00280102,
    PixelRepresentation: 0x00280103,
    WindowCenter: 0x00281050,
    WindowWidth: 0x00281051,
    RescaleIntercept: 0x00281052,
    RescaleSlope: 0x00281053,
    RescaleType: 0x00281054,
    PixelData: 0x7fe00010,
    // DICOMDIR
    FileSetID: 0x00041130,
    DirectoryRecordSequence: 0x00041220,
    DirectoryRecordType: 0x00041430,
    ReferencedFileID: 0x00041500,
    ReferencedSOPInstanceUIDInFile: 0x00041511,
  };

  // VR lookup for implicit-VR parsing, only for tags we read values from.
  const IMPLICIT_VR = {};
  const setVR = (tag, vr) => { IMPLICIT_VR[tag] = vr; };
  setVR(TAGS.SpecificCharacterSet, 'CS'); setVR(TAGS.ImageType, 'CS');
  setVR(TAGS.SOPClassUID, 'UI'); setVR(TAGS.SOPInstanceUID, 'UI');
  setVR(TAGS.StudyDate, 'DA'); setVR(TAGS.SeriesDate, 'DA'); setVR(TAGS.AcquisitionDate, 'DA');
  setVR(TAGS.StudyTime, 'TM'); setVR(TAGS.Modality, 'CS');
  setVR(TAGS.Manufacturer, 'LO'); setVR(TAGS.InstitutionName, 'LO');
  setVR(TAGS.StudyDescription, 'LO'); setVR(TAGS.SeriesDescription, 'LO');
  setVR(TAGS.PatientName, 'PN'); setVR(TAGS.PatientID, 'LO');
  setVR(TAGS.PatientBirthDate, 'DA'); setVR(TAGS.PatientSex, 'CS');
  setVR(TAGS.SliceThickness, 'DS'); setVR(TAGS.SpacingBetweenSlices, 'DS');
  setVR(TAGS.ProtocolName, 'LO');
  setVR(TAGS.StudyInstanceUID, 'UI'); setVR(TAGS.SeriesInstanceUID, 'UI');
  setVR(TAGS.StudyID, 'SH'); setVR(TAGS.SeriesNumber, 'IS'); setVR(TAGS.AcquisitionNumber, 'IS');
  setVR(TAGS.InstanceNumber, 'IS');
  setVR(TAGS.ImagePositionPatient, 'DS'); setVR(TAGS.ImageOrientationPatient, 'DS');
  setVR(TAGS.FrameOfReferenceUID, 'UI'); setVR(TAGS.SliceLocation, 'DS');
  setVR(TAGS.SamplesPerPixel, 'US'); setVR(TAGS.PhotometricInterpretation, 'CS');
  setVR(TAGS.PlanarConfiguration, 'US'); setVR(TAGS.NumberOfFrames, 'IS');
  setVR(TAGS.Rows, 'US'); setVR(TAGS.Columns, 'US'); setVR(TAGS.PixelSpacing, 'DS');
  setVR(TAGS.BitsAllocated, 'US'); setVR(TAGS.BitsStored, 'US');
  setVR(TAGS.HighBit, 'US'); setVR(TAGS.PixelRepresentation, 'US');
  setVR(TAGS.WindowCenter, 'DS'); setVR(TAGS.WindowWidth, 'DS');
  setVR(TAGS.RescaleIntercept, 'DS'); setVR(TAGS.RescaleSlope, 'DS'); setVR(TAGS.RescaleType, 'LO');
  setVR(TAGS.FileSetID, 'CS'); setVR(TAGS.DirectoryRecordType, 'CS');
  setVR(TAGS.ReferencedFileID, 'CS'); setVR(TAGS.ReferencedSOPInstanceUIDInFile, 'UI');

  const LONG_LENGTH_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UC', 'UR', 'UN']);
  const UNDEFINED_LENGTH = 0xffffffff;

  class NeedMoreData extends Error {
    constructor(wanted) { super('need more data'); this.wanted = wanted; }
  }

  class Reader {
    constructor(bytes, littleEndian) {
      this.b = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = 0;
      this.le = littleEndian !== false;
    }
    ensure(n) { if (this.pos + n > this.b.length) throw new NeedMoreData(this.pos + n); }
    u16() { this.ensure(2); const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
    u32() { this.ensure(4); const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
    bytes(n) { this.ensure(n); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    skip(n) { this.pos += n; } // may run past end; checked by callers via ensure/eof
    eof() { return this.pos >= this.b.length; }
  }

  function bytesToString(bytes) {
    // latin-1 decode covers the default repertoire and ISO_IR 100
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s.replace(/\0+$/, '').trim();
  }

  class Dataset {
    constructor() {
      this.elements = new Map(); // tag -> {vr, bytes | items}
      this.pixel = null;         // {offset, length, vr, encapsulated}
      this.transferSyntax = TS.IMPLICIT_LE;
      this.truncated = false;    // parse stopped early (buffer too small)
    }
    has(tag) { return this.elements.has(tag); }
    _el(tag) { return this.elements.get(tag); }
    string(tag) {
      const el = this._el(tag);
      if (!el || !el.bytes) return null;
      const s = bytesToString(el.bytes);
      return s.length ? s : null;
    }
    strings(tag) {
      const s = this.string(tag);
      return s === null ? [] : s.split('\\').map((x) => x.trim());
    }
    number(tag) {
      const el = this._el(tag);
      if (!el || !el.bytes) return null;
      const vr = el.vr;
      const view = new DataView(el.bytes.buffer, el.bytes.byteOffset, el.bytes.byteLength);
      const le = this.transferSyntax !== TS.EXPLICIT_BE;
      if (vr === 'US') return el.bytes.length >= 2 ? view.getUint16(0, le) : null;
      if (vr === 'SS') return el.bytes.length >= 2 ? view.getInt16(0, le) : null;
      if (vr === 'UL') return el.bytes.length >= 4 ? view.getUint32(0, le) : null;
      if (vr === 'SL') return el.bytes.length >= 4 ? view.getInt32(0, le) : null;
      if (vr === 'FL') return el.bytes.length >= 4 ? view.getFloat32(0, le) : null;
      if (vr === 'FD') return el.bytes.length >= 8 ? view.getFloat64(0, le) : null;
      const s = this.string(tag);
      if (s === null) return null;
      const v = parseFloat(s.split('\\')[0]);
      return Number.isFinite(v) ? v : null;
    }
    numbers(tag) {
      const el = this._el(tag);
      if (!el || !el.bytes) return [];
      const vr = el.vr;
      if (vr === 'DS' || vr === 'IS' || !vr) {
        return this.strings(tag).map(parseFloat).filter(Number.isFinite);
      }
      const view = new DataView(el.bytes.buffer, el.bytes.byteOffset, el.bytes.byteLength);
      const le = this.transferSyntax !== TS.EXPLICIT_BE;
      const out = [];
      if (vr === 'US') for (let i = 0; i + 2 <= el.bytes.length; i += 2) out.push(view.getUint16(i, le));
      else if (vr === 'SS') for (let i = 0; i + 2 <= el.bytes.length; i += 2) out.push(view.getInt16(i, le));
      else if (vr === 'UL') for (let i = 0; i + 4 <= el.bytes.length; i += 4) out.push(view.getUint32(i, le));
      else if (vr === 'FL') for (let i = 0; i + 4 <= el.bytes.length; i += 4) out.push(view.getFloat32(i, le));
      else if (vr === 'FD') for (let i = 0; i + 8 <= el.bytes.length; i += 8) out.push(view.getFloat64(i, le));
      else return this.strings(tag).map(parseFloat).filter(Number.isFinite);
      return out;
    }
    sequence(tag) {
      const el = this._el(tag);
      return el && el.items ? el.items : null;
    }
  }

  /**
   * Parse one dataset region [reader.pos, end) with the given syntax.
   * `capture` decides which tag values to retain (default: all except pixel).
   * Fills `ds`; returns when end reached or PixelData recorded.
   */
  function parseElements(reader, end, explicit, ds, baseOffset, depth) {
    while (reader.pos < end && !reader.eof()) {
      const elStart = reader.pos;
      const group = reader.u16();
      const elem = reader.u16();
      const tag = ((group << 16) >>> 0) | elem;

      // Item delimiters bubble up to sequence handling
      if (group === 0xfffe) {
        const len = reader.u32();
        if (elem === 0xe00d || elem === 0xe0dd) return { delimiter: tag, at: elStart };
        // unexpected bare item — skip
        if (len !== UNDEFINED_LENGTH) reader.skip(len);
        continue;
      }

      let vr = null, length = 0;
      if (explicit) {
        vr = bytesToString(reader.bytes(2));
        if (LONG_LENGTH_VRS.has(vr)) { reader.u16(); length = reader.u32(); }
        else length = reader.u16();
      } else {
        length = reader.u32();
        vr = IMPLICIT_VR[tag] || null;
      }

      if (tag === TAGS.PixelData) {
        const encapsulated = length === UNDEFINED_LENGTH;
        ds.pixel = {
          offset: baseOffset + reader.pos,
          length: encapsulated ? -1 : length,
          vr: vr || (ds.number(TAGS.BitsAllocated) === 8 ? 'OB' : 'OW'),
          encapsulated,
        };
        return { pixelReached: true };
      }

      if (length === UNDEFINED_LENGTH) {
        // Sequence (or UN behaving like one). Items parse with implicit VR when
        // the element itself is UN; otherwise same syntax as enclosing dataset.
        const itemsExplicit = vr === 'UN' ? false : explicit;
        const wantItems = tag === TAGS.DirectoryRecordSequence && depth === 0;
        const items = parseSequenceItems(reader, end, itemsExplicit, ds, baseOffset, wantItems, depth + 1);
        if (wantItems) ds.elements.set(tag, { vr: 'SQ', items });
        continue;
      }

      const isSq = vr === 'SQ' || (!explicit && looksLikeSequence(reader, length));
      if (isSq) {
        const sqEnd = reader.pos + length;
        if (sqEnd > reader.b.length) throw new NeedMoreData(sqEnd);
        const wantItems = tag === TAGS.DirectoryRecordSequence && depth === 0;
        const items = parseSequenceItems(reader, sqEnd, vr === 'UN' ? false : explicit, ds, baseOffset, wantItems, depth + 1);
        if (wantItems) ds.elements.set(tag, { vr: 'SQ', items });
        reader.pos = sqEnd;
        continue;
      }

      // Ordinary element: keep value only at top level (avoid nested overwrite)
      if (depth === 0 && (IMPLICIT_VR[tag] !== undefined || explicit)) {
        if (reader.pos + length > reader.b.length) throw new NeedMoreData(reader.pos + length);
        // retain only tags we know / reasonable sizes to save memory
        if (IMPLICIT_VR[tag] !== undefined || length <= 512) {
          ds.elements.set(tag, { vr: vr || IMPLICIT_VR[tag] || null, bytes: reader.bytes(length) });
        } else {
          reader.skip(length);
        }
      } else {
        if (reader.pos + length > reader.b.length) throw new NeedMoreData(reader.pos + length);
        reader.skip(length);
      }
    }
    return {};
  }

  /** Heuristic: in implicit VR, a defined-length value starting with an item tag is a sequence. */
  function looksLikeSequence(reader, length) {
    if (length < 8 || reader.pos + 8 > reader.b.length) return false;
    const v = reader.view;
    const g = v.getUint16(reader.pos, true), e = v.getUint16(reader.pos + 2, true);
    return g === 0xfffe && e === 0xe000;
  }

  /** Parse sequence items until end-of-sequence delimiter or `end`. */
  function parseSequenceItems(reader, end, explicit, parentDs, baseOffset, wantItems, depth) {
    const items = [];
    while (reader.pos < end && !reader.eof()) {
      const group = reader.u16();
      const elem = reader.u16();
      const len = reader.u32();
      if (group === 0xfffe && elem === 0xe0dd) return items; // sequence delimiter
      if (group !== 0xfffe || elem !== 0xe000) {
        // Malformed; bail out of the sequence
        reader.pos = end === Infinity ? reader.b.length : end;
        return items;
      }
      const itemEnd = len === UNDEFINED_LENGTH ? end : reader.pos + len;
      if (wantItems) {
        const item = new Dataset();
        item.transferSyntax = parentDs.transferSyntax;
        const sub = parseItemDataset(reader, itemEnd, explicit, item, baseOffset);
        items.push(item);
        if (len !== UNDEFINED_LENGTH) reader.pos = itemEnd;
        else if (!sub || sub.delimiter !== 0xfffee00d) { /* delimiter consumed inside */ }
      } else {
        if (len === UNDEFINED_LENGTH) {
          skipUndefinedItem(reader, end, explicit);
        } else {
          if (reader.pos + len > reader.b.length) throw new NeedMoreData(reader.pos + len);
          reader.skip(len);
        }
      }
    }
    return items;
  }

  /** Parse a sequence item's elements into `item` (captured at depth 0 of the item). */
  function parseItemDataset(reader, end, explicit, item, baseOffset) {
    while (reader.pos < end && !reader.eof()) {
      const elStart = reader.pos;
      const group = reader.u16();
      const elem = reader.u16();
      if (group === 0xfffe && (elem === 0xe00d || elem === 0xe0dd)) {
        reader.u32();
        return { delimiter: ((group << 16) >>> 0) | elem, at: elStart };
      }
      const tag = ((group << 16) >>> 0) | elem;
      let vr = null, length = 0;
      if (explicit) {
        vr = bytesToString(reader.bytes(2));
        if (LONG_LENGTH_VRS.has(vr)) { reader.u16(); length = reader.u32(); }
        else length = reader.u16();
      } else {
        length = reader.u32();
        vr = IMPLICIT_VR[tag] || null;
      }
      if (length === UNDEFINED_LENGTH || vr === 'SQ' || (!explicit && looksLikeSequence(reader, length))) {
        // nested sequence inside a directory record — skip its content
        if (length === UNDEFINED_LENGTH) {
          parseSequenceItems(reader, end, vr === 'UN' ? false : explicit, item, baseOffset, false, 9);
        } else {
          if (reader.pos + length > reader.b.length) throw new NeedMoreData(reader.pos + length);
          reader.skip(length);
        }
        continue;
      }
      if (reader.pos + length > reader.b.length) throw new NeedMoreData(reader.pos + length);
      if (length <= 4096) {
        item.elements.set(tag, { vr, bytes: reader.bytes(length) });
      } else {
        reader.skip(length);
      }
    }
    return {};
  }

  /** Skip an undefined-length item by walking its elements. */
  function skipUndefinedItem(reader, end, explicit) {
    const dummy = new Dataset();
    parseItemDataset(reader, end, explicit, dummy, 0);
  }

  /**
   * Parse a DICOM Part 10 file (or raw dataset without preamble).
   * `bytes` may be a partial prefix of the file; throws NeedMoreData if it
   * ends before the header (through PixelData) could be parsed.
   */
  function parse(bytes) {
    const ds = new Dataset();
    let reader = new Reader(bytes, true);
    let offset = 0;
    let mainExplicit = false;
    let mainLE = true;

    const hasPreamble = bytes.length >= 132 && bytesToString(bytes.subarray(128, 132)) === 'DICM';
    if (hasPreamble) {
      reader.pos = 132;
      // File meta group (0002): always explicit VR LE
      let ts = null;
      while (!reader.eof()) {
        const save = reader.pos;
        const group = reader.u16();
        if (group !== 0x0002) { reader.pos = save; break; }
        const elem = reader.u16();
        let vr = bytesToString(reader.bytes(2));
        let length;
        if (LONG_LENGTH_VRS.has(vr)) { reader.u16(); length = reader.u32(); }
        else length = reader.u16();
        if (reader.pos + length > bytes.length) throw new NeedMoreData(reader.pos + length);
        const val = reader.bytes(length);
        if (elem === 0x0010) ts = bytesToString(val);
      }
      ds.transferSyntax = ts || TS.EXPLICIT_LE;
    } else {
      // No preamble: guess syntax from first element
      const looksExplicit = bytes.length >= 8 && /^[A-Z]{2}$/.test(bytesToString(bytes.subarray(4, 6)));
      ds.transferSyntax = looksExplicit ? TS.EXPLICIT_LE : TS.IMPLICIT_LE;
    }

    if (ds.transferSyntax === TS.IMPLICIT_LE) { mainExplicit = false; mainLE = true; }
    else if (ds.transferSyntax === TS.EXPLICIT_BE) { mainExplicit = true; mainLE = false; }
    else { mainExplicit = true; mainLE = true; } // explicit LE and all encapsulated syntaxes

    const mainReader = new Reader(bytes, mainLE);
    mainReader.pos = reader.pos;
    parseElements(mainReader, bytes.length, mainExplicit, ds, offset, 0);

    const compressed = ds.transferSyntax !== TS.IMPLICIT_LE &&
      ds.transferSyntax !== TS.EXPLICIT_LE && ds.transferSyntax !== TS.EXPLICIT_BE;
    if (ds.pixel) ds.pixel.compressed = compressed || ds.pixel.encapsulated;
    return ds;
  }

  /**
   * Decode uncompressed pixel data into a typed array (no windowing applied).
   * `fileBytes` must contain the full pixel data range.
   * Returns {data, width, height, samples, signed, bitsAllocated, planar}.
   */
  function decodePixels(ds, fileBytes) {
    if (!ds.pixel) throw new Error('No PixelData element');
    if (ds.pixel.compressed) throw new Error('Compressed pixel data not supported');
    const rows = ds.number(TAGS.Rows), cols = ds.number(TAGS.Columns);
    const samples = ds.number(TAGS.SamplesPerPixel) || 1;
    const bitsAllocated = ds.number(TAGS.BitsAllocated) || 16;
    const bitsStored = ds.number(TAGS.BitsStored) || bitsAllocated;
    const highBit = ds.number(TAGS.HighBit) ?? (bitsStored - 1);
    const signed = ds.number(TAGS.PixelRepresentation) === 1;
    const planar = ds.number(TAGS.PlanarConfiguration) === 1;
    const frames = Math.max(1, parseInt(ds.string(TAGS.NumberOfFrames) || '1', 10) || 1);
    if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(cols) || cols <= 0) {
      throw new Error('Invalid image dimensions');
    }
    if (samples !== 1 && samples !== 3) throw new Error(`Unsupported SamplesPerPixel: ${samples}`);
    if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error(`Unsupported BitsAllocated: ${bitsAllocated}`);
    if (bitsStored < 1 || bitsStored > bitsAllocated || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
      throw new Error(`Invalid stored-bit layout: BitsStored=${bitsStored}, HighBit=${highBit}`);
    }
    const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;
    const frameLen = rows * cols * samples * bytesPerSample;
    const start = ds.pixel.offset;
    if (start + frameLen > fileBytes.length) throw new Error('Pixel data truncated');
    const le = ds.transferSyntax !== TS.EXPLICIT_BE;
    const lowBit = highBit - bitsStored + 1;
    const valueRange = 2 ** bitsStored;
    const mask = valueRange - 1;
    const signBit = 2 ** (bitsStored - 1);

    const normalize = (raw) => {
      const stored = Math.floor(raw / (2 ** lowBit)) & mask;
      return signed && stored >= signBit ? stored - valueRange : stored;
    };

    const decodeFrame = (frameIndex) => {
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= frames) {
        throw new Error(`Frame index out of range: ${frameIndex}`);
      }
      const off = start + frameIndex * frameLen;
      if (off + frameLen > fileBytes.length) throw new Error('Pixel data truncated');
      const raw = fileBytes.subarray(off, off + frameLen);
      if (bytesPerSample === 1) {
        let data;
        if (signed) {
          data = new Int8Array(raw.length);
          for (let i = 0; i < raw.length; i++) data[i] = normalize(raw[i]);
        } else if (lowBit || bitsStored < 8) {
          data = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) data[i] = normalize(raw[i]);
        } else {
          data = new Uint8Array(raw); // copy
        }
        if (samples === 3 && planar) {
          const n = rows * cols, out = signed ? new Int8Array(n * 3) : new Uint8Array(n * 3);
          for (let i = 0; i < n; i++) {
            out[i * 3] = data[i];
            out[i * 3 + 1] = data[n + i];
            out[i * 3 + 2] = data[2 * n + i];
          }
          data = out;
        }
        return { data, width: cols, height: rows, samples, signed, bitsAllocated: 8 };
      }
      const n = rows * cols * samples;
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      if (signed) {
        const data = new Int16Array(n);
        for (let i = 0; i < n; i++) data[i] = normalize(view.getUint16(i * 2, le));
        return { data, width: cols, height: rows, samples, signed: true, bitsAllocated: 16 };
      }
      const data = new Uint16Array(n);
      for (let i = 0; i < n; i++) data[i] = normalize(view.getUint16(i * 2, le));
      return { data, width: cols, height: rows, samples, signed: false, bitsAllocated: 16 };
    };

    const first = decodeFrame(0);
    first.frames = frames;
    first.decodeFrame = decodeFrame;
    return first;
  }

  const api = { parse, decodePixels, Dataset, NeedMoreData, TAGS, TS };
  global.DICOM = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
