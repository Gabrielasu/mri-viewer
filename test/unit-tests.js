'use strict';

const assert = require('assert');
const DICOM = require('../js/dicom.js');
const STACK = require('../js/stack.js');
const RENDER = require('../js/render.js');

const T = DICOM.TAGS;

function us(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return { vr: 'US', bytes };
}

function makeDataset({ rows = 1, cols, bitsAllocated, bitsStored, highBit, signed = false, samples = 1 }) {
  const ds = new DICOM.Dataset();
  ds.transferSyntax = DICOM.TS.EXPLICIT_LE;
  ds.elements.set(T.Rows, us(rows));
  ds.elements.set(T.Columns, us(cols));
  ds.elements.set(T.SamplesPerPixel, us(samples));
  ds.elements.set(T.BitsAllocated, us(bitsAllocated));
  ds.elements.set(T.BitsStored, us(bitsStored));
  ds.elements.set(T.HighBit, us(highBit));
  ds.elements.set(T.PixelRepresentation, us(signed ? 1 : 0));
  ds.pixel = { offset: 0, length: rows * cols * samples * (bitsAllocated / 8), compressed: false };
  return ds;
}

function le16(values) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value, true));
  return bytes;
}

function decode(options, bytes) {
  return DICOM.decodePixels(makeDataset(options), bytes).data;
}

assert.deepStrictEqual(
  [...decode({ cols: 4, bitsAllocated: 16, bitsStored: 16, highBit: 15 }, le16([0, 32767, 32768, 65535]))],
  [0, 32767, 32768, 65535],
  'unsigned 16-bit values retain their full range',
);

assert.deepStrictEqual(
  [...decode({ cols: 4, bitsAllocated: 16, bitsStored: 12, highBit: 14, signed: true },
    le16([0x4000, 0x7ff8, 0x0000, 0x3ff8]))],
  [-2048, -1, 0, 2047],
  'signed values honor BitsStored and a non-default HighBit',
);

assert.deepStrictEqual(
  [...decode({ cols: 4, bitsAllocated: 8, bitsStored: 7, highBit: 6, signed: true },
    Uint8Array.from([0x40, 0x7f, 0x00, 0x3f]))],
  [-64, -1, 0, 63],
  'signed 8-bit pixels are sign-extended',
);

assert.deepStrictEqual(
  [...decode({ cols: 4, bitsAllocated: 8, bitsStored: 6, highBit: 7 },
    Uint8Array.from([0x00, 0x04, 0x80, 0xfc]))],
  [0, 1, 32, 63],
  'left-aligned unsigned 8-bit pixels are normalized',
);

const stack = [
  { meta: { orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, 4], instanceNumber: 3 } },
  { meta: { orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, -2], instanceNumber: 1 } },
  { meta: { orientation: [1, 0, 0, 0, 1, 0], position: [0, 0, 1], instanceNumber: 2 } },
];
STACK.sortInstances(stack);
assert.deepStrictEqual(stack.map((item) => item.meta.position[2]), [-2, 1, 4], 'stacks sort geometrically');

assert.deepStrictEqual(
  RENDER.orientationLabels([1, 0, 0, 0, 1, 0]),
  { right: 'L', left: 'R', bottom: 'P', top: 'A' },
  'orientation labels match the DICOM patient axes',
);

console.log('Unit tests: all checks passed');
