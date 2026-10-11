/*
 * Stack ordering: sorts series instances into spatial order.
 * Pure functions, shared between the browser app and Node tests.
 */
(function (global) {
  'use strict';

  /**
   * Sort instances (each with .meta from app's buildMeta) into a stack.
   * Prefers projecting ImagePositionPatient onto the slice normal, then
   * SliceLocation, then InstanceNumber. Mutates and returns the array.
   */
  function sortInstances(ok) {
    if (ok.length < 2) return ok;
    const haveGeom = ok.every((i) => i.meta &&
      i.meta.position && i.meta.position.length === 3 &&
      i.meta.orientation && i.meta.orientation.length === 6);
    const instNum = (i) => i.meta && i.meta.instanceNumber != null ? i.meta.instanceNumber
      : (i.instanceNumber != null ? i.instanceNumber : 0);
    if (haveGeom) {
      const o = ok[0].meta.orientation;
      const n = [
        o[1] * o[5] - o[2] * o[4],
        o[2] * o[3] - o[0] * o[5],
        o[0] * o[4] - o[1] * o[3],
      ];
      for (const inst of ok) {
        const p = inst.meta.position;
        inst.sortKey = p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
      }
      ok.sort((a, b) => (a.sortKey - b.sortKey) || (instNum(a) - instNum(b)));
      return ok;
    }
    if (ok.every((i) => i.meta && i.meta.sliceLocation != null)) {
      ok.sort((a, b) => (a.meta.sliceLocation - b.meta.sliceLocation) || (instNum(a) - instNum(b)));
      return ok;
    }
    ok.sort((a, b) => instNum(a) - instNum(b));
    return ok;
  }

  const api = { sortInstances };
  global.STACK = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
