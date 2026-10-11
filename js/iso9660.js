/*
 * Minimal ISO 9660 filesystem reader operating over an async byte source.
 * Supports plain ISO 9660 (level 1-3) and Joliet supplementary descriptors.
 * Random access only — never loads the whole image into memory.
 */
(function (global) {
  'use strict';

  const SECTOR = 2048;

  /** Async byte source over a browser Blob/File. */
  class BlobSource {
    constructor(blob) {
      this.blob = blob;
      this.size = blob.size;
      this.name = blob.name || 'image';
    }
    async read(offset, length) {
      const end = Math.min(offset + length, this.size);
      if (offset >= this.size) return new Uint8Array(0);
      const buf = await this.blob.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    }
  }

  function readU16LE(b, o) { return b[o] | (b[o + 1] << 8); }
  function readU32LE(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function decodeName(bytes, joliet) {
    if (joliet) {
      // UCS-2 big endian
      let s = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return s;
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** Strip ISO version suffix (";1") and trailing dot from a file identifier. */
  function cleanName(name) {
    const sc = name.indexOf(';');
    if (sc >= 0) name = name.slice(0, sc);
    if (name.endsWith('.')) name = name.slice(0, -1);
    return name;
  }

  class IsoEntry {
    constructor(name, path, isDir) {
      this.name = name;
      this.path = path;        // full path with '/' separators, no leading '/'
      this.isDir = isDir;
      this.extents = [];       // [{lba, length}] — multi-extent files concatenate
      this.children = isDir ? [] : null;
    }
    get size() {
      let n = 0;
      for (const e of this.extents) n += e.length;
      return n;
    }
  }

  class Iso9660 {
    constructor(source) {
      this.source = source;
      this.joliet = false;
      this.rootRecord = null;
      this.volumeId = '';
    }

    static async open(source) {
      const iso = new Iso9660(source);
      await iso._readVolumeDescriptors();
      return iso;
    }

    async _readVolumeDescriptors() {
      let primary = null, supplementary = null, primaryVolId = '';
      for (let lba = 16; lba < 16 + 64; lba++) {
        const sec = await this.source.read(lba * SECTOR, SECTOR);
        if (sec.length < SECTOR) break;
        const type = sec[0];
        const magic = decodeName(sec.subarray(1, 6), false);
        if (magic !== 'CD001') {
          if (lba === 16) throw new Error('Not an ISO 9660 image (missing CD001 signature)');
          break;
        }
        if (type === 255) break; // terminator
        if (type === 1 && !primary) {
          primary = sec.slice(156, 156 + 34);
          primaryVolId = decodeName(sec.subarray(40, 72), false).trim();
        } else if (type === 2) {
          // Joliet is identified by UCS-2 escape sequences at offset 88
          const esc = sec.subarray(88, 120);
          const escStr = decodeName(esc, false);
          if (escStr.includes('%/@') || escStr.includes('%/C') || escStr.includes('%/E')) {
            supplementary = sec.slice(156, 156 + 34);
          }
        }
      }
      if (!primary && !supplementary) throw new Error('No usable volume descriptor found');
      if (supplementary) {
        this.joliet = true;
        this.rootRecord = supplementary;
      } else {
        this.rootRecord = primary;
      }
      this.volumeId = primaryVolId;
    }

    /** Parse one directory record. Returns null for empty/padding records. */
    _parseRecord(buf, offset) {
      const len = buf[offset];
      if (!len) return null;
      const extLba = readU32LE(buf, offset + 2);
      const dataLen = readU32LE(buf, offset + 10);
      const flags = buf[offset + 25];
      const nameLen = buf[offset + 32];
      const nameBytes = buf.subarray(offset + 33, offset + 33 + nameLen);
      let name;
      if (nameLen === 1 && (nameBytes[0] === 0 || nameBytes[0] === 1)) {
        name = nameBytes[0] === 0 ? '.' : '..';
      } else {
        name = cleanName(decodeName(nameBytes, this.joliet));
      }
      return {
        recordLength: len,
        lba: extLba,
        length: dataLen,
        isDir: (flags & 0x02) !== 0,
        multiExtent: (flags & 0x80) !== 0,
        name,
      };
    }

    /** Read all records of one directory extent. */
    async _readDirectory(lba, length) {
      const data = await this.source.read(lba * SECTOR, length);
      const records = [];
      let pos = 0;
      while (pos < data.length) {
        if (data[pos] === 0) {
          // end of records for this sector; skip to next sector boundary
          pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
          continue;
        }
        const rec = this._parseRecord(data, pos);
        if (!rec) break;
        records.push(rec);
        pos += rec.recordLength;
      }
      return records;
    }

    /**
     * Walk the whole directory tree. Returns the root IsoEntry;
     * `files` property lists all non-directory entries flat.
     */
    async readTree() {
      const rootRec = this._parseRecord(this.rootRecord, 0);
      const root = new IsoEntry('', '', true);
      root.extents.push({ lba: rootRec.lba, length: rootRec.length });
      const files = [];
      const visited = new Set();
      const walk = async (entry) => {
        const key = entry.extents[0].lba;
        if (visited.has(key)) return; // guard against directory loops
        visited.add(key);
        const recs = await this._readDirectory(entry.extents[0].lba, entry.extents[0].length);
        let prevFile = null;
        for (const rec of recs) {
          if (rec.name === '.' || rec.name === '..') continue;
          if (rec.isDir) {
            const child = new IsoEntry(rec.name, entry.path ? entry.path + '/' + rec.name : rec.name, true);
            child.extents.push({ lba: rec.lba, length: rec.length });
            entry.children.push(child);
            await walk(child);
          } else {
            // Multi-extent files: consecutive records with the same name; all but
            // the last have the multiExtent flag set.
            if (prevFile && prevFile.pending && prevFile.entry.name === rec.name) {
              prevFile.entry.extents.push({ lba: rec.lba, length: rec.length });
              prevFile.pending = rec.multiExtent;
              continue;
            }
            const child = new IsoEntry(rec.name, entry.path ? entry.path + '/' + rec.name : rec.name, false);
            child.extents.push({ lba: rec.lba, length: rec.length });
            entry.children.push(child);
            files.push(child);
            prevFile = { entry: child, pending: rec.multiExtent };
          }
        }
      };
      await walk(root);
      root.files = files;
      return root;
    }

    /** Read `length` bytes at `offset` within a (possibly multi-extent) file. */
    async readFile(entry, offset = 0, length = entry.size) {
      length = Math.min(length, Math.max(0, entry.size - offset));
      if (length <= 0) return new Uint8Array(0);
      const out = new Uint8Array(length);
      let written = 0, skip = offset;
      for (const ext of entry.extents) {
        if (written >= length) break;
        if (skip >= ext.length) { skip -= ext.length; continue; }
        const want = Math.min(ext.length - skip, length - written);
        const chunk = await this.source.read(ext.lba * SECTOR + skip, want);
        out.set(chunk, written);
        written += chunk.length;
        skip = 0;
        if (chunk.length < want) break; // truncated image
      }
      return written === length ? out : out.subarray(0, written);
    }
  }

  const api = { Iso9660, BlobSource, IsoEntry };
  global.ISO9660 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
