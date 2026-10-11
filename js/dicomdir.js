/*
 * DICOMDIR interpretation: flattens the DirectoryRecordSequence (which
 * standard writers emit in hierarchical order) into a
 * patient → study → series → image tree with referenced file paths.
 */
(function (global) {
  'use strict';

  const D = typeof module !== 'undefined' && module.exports ? require('./dicom.js') : global.DICOM;
  const T = D.TAGS;

  /**
   * Build an index from a parsed DICOMDIR dataset.
   * Returns {patients: [{name, id, birthDate, sex, studies: [...]}]} where each
   * image holds `fileId` — an array of path components as recorded on disc.
   */
  function buildIndex(ds) {
    const seq = ds.sequence(T.DirectoryRecordSequence);
    if (!seq || !seq.length) return null;
    const patients = [];
    let curPatient = null, curStudy = null, curSeries = null;
    for (const rec of seq) {
      const type = (rec.string(T.DirectoryRecordType) || '').toUpperCase();
      if (type === 'PATIENT') {
        curPatient = {
          name: rec.string(T.PatientName) || 'Unknown',
          id: rec.string(T.PatientID) || '',
          birthDate: rec.string(T.PatientBirthDate) || '',
          sex: rec.string(T.PatientSex) || '',
          studies: [],
        };
        patients.push(curPatient);
        curStudy = curSeries = null;
      } else if (type === 'STUDY') {
        if (!curPatient) { curPatient = { name: 'Unknown', id: '', birthDate: '', sex: '', studies: [] }; patients.push(curPatient); }
        curStudy = {
          uid: rec.string(T.StudyInstanceUID) || '',
          date: rec.string(T.StudyDate) || '',
          description: rec.string(T.StudyDescription) || '',
          series: [],
        };
        curPatient.studies.push(curStudy);
        curSeries = null;
      } else if (type === 'SERIES') {
        if (!curStudy) continue;
        curSeries = {
          uid: rec.string(T.SeriesInstanceUID) || '',
          modality: rec.string(T.Modality) || '',
          number: rec.number(T.SeriesNumber),
          description: rec.string(T.SeriesDescription) || '',
          images: [],
        };
        curStudy.series.push(curSeries);
      } else if (type === 'IMAGE') {
        if (!curSeries) continue;
        const fileId = rec.strings(T.ReferencedFileID);
        if (!fileId.length) continue;
        curSeries.images.push({
          fileId,
          instanceNumber: rec.number(T.InstanceNumber),
        });
      }
      // other record types (PRESENTATION, SR DOCUMENT, ...) are ignored
    }
    // prune empty branches
    for (const p of patients) {
      for (const st of p.studies) st.series = st.series.filter((s) => s.images.length);
      p.studies = p.studies.filter((st) => st.series.length);
    }
    return { patients: patients.filter((p) => p.studies.length) };
  }

  const api = { buildIndex };
  global.DICOMDIR = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
