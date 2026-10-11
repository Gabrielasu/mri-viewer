# DICOM Disc Viewer

A simple in-browser viewer for MRI / CT / X-ray discs (`.iso` files). No
install, no upload. Everything runs locally in your browser.

> [!WARNING]
> **For personal use only. Not a medical device.**
> This is a hobby project for looking at your own scans out of curiosity. Do
> **not** use it to diagnose, treat, or make any medical decisions. It is not
> validated, certified, or approved for clinical use, and images may be
> displayed incorrectly or incompletely. Always rely on a qualified medical
> professional and the official radiology report. Provided as-is, with no
> warranty.

## Usage

1. Open `index.html` in Chrome, Safari, Edge, or Firefox.
2. Drag in one or more `.iso` files (or click **Open files…**). Folders of
   DICOM files and individual DICOM files also work.
3. Pick a series from the sidebar and scroll through slices.

**Privacy:** files are read directly from disk. Nothing is uploaded or saved.
Keep private scans outside this repo (or under `data/`, `scans/`, or
`patient-data/`, which are gitignored).

## Controls

| Input | Action |
|---|---|
| Mouse wheel, ← → ↑ ↓, PgUp/PgDn, Home/End | Navigate slices |
| Left-drag | Active tool (Window/Level, Pan, Zoom, Measure) |
| Right-drag, pinch | Zoom |
| Middle-drag, Space+drag | Pan |
| Double-click | Fit to window |
| 1 / 2 / 3 / 4 | W/L · Pan · Zoom · Measure tool |
| i / r / p / c | Invert · Reset · Cine · Clear measurements |

CT window presets are in the preset menu. The status bar shows the pixel value
(HU for CT) under the cursor.

**Export:** PNG of the current view, a ZIP of a series, a ZIP of the whole
scan, or a ZIP of all loaded scans. ZIP exports omit patient overlays and
measurements.

## Supported

- ISO 9660 disc images (incl. Joliet), DICOMDIR indexing with fallback scan
- Uncompressed DICOM (implicit & explicit VR little-endian)
- CT, MR, CR/X-ray, secondary captures
- Compressed (JPEG / JPEG 2000) images are detected but not decoded

## Development

```
node test/unit-tests.js
ISO_DIR=/path/to/private/discs node test/run-tests.js
ISO_DIR=/path/to/private/discs node test/e2e-chrome.js
```

Real-disc tests use private, gitignored fixtures. `js/iso9660.js`,
`js/dicom.js`, `js/dicomdir.js`, and `js/stack.js` run in both browser and
Node; `js/render.js` is the viewport and `js/app.js` the app shell.
