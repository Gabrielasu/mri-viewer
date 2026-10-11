/*
 * Canvas viewport: windowing LUT, zoom/pan, overlays, measurement, probe.
 * Slice pixel data is supplied by the app through an async provider; the
 * viewport only handles presentation and interaction.
 */
(function (global) {
  'use strict';

  const WINDOW_PRESETS = {
    CT: [
      { name: 'Brain', wc: 40, ww: 80 },
      { name: 'Subdural', wc: 75, ww: 215 },
      { name: 'Stroke', wc: 40, ww: 40 },
      { name: 'Soft tissue', wc: 50, ww: 400 },
      { name: 'Lung', wc: -600, ww: 1500 },
      { name: 'Bone', wc: 480, ww: 2500 },
      { name: 'Liver', wc: 90, ww: 150 },
    ],
    DEFAULT: [],
  };

  class Viewport {
    constructor(canvas, callbacks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = callbacks || {}; // {onSliceRequest(delta), onStateChange(), onProbe(info)}
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
      this.slice = null;        // {pixels:{data,width,height,samples,signed}, meta}
      this.wc = 40; this.ww = 400;
      this.zoom = 1; this.panX = 0; this.panY = 0;
      this.invert = false;
      this.tool = 'wl';
      this.lut = null;
      this.lutKey = '';
      this.measurements = new Map(); // sliceKey -> [{x0,y0,x1,y1}]
      this.sliceKey = '';
      this.overlay = {};           // corner text
      this.aspect = 1;             // rowSpacing / colSpacing
      this._drag = null;
      this._pendingMeasure = null;
      this._raf = 0;
      this._bindEvents();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
      }
      this.requestRender();
    }

    setSlice(slice, sliceKey, keepView) {
      const prev = this.slice;
      this.slice = slice;
      this.sliceKey = sliceKey || '';
      const m = slice.meta || {};
      const spacing = m.pixelSpacing;
      this.aspect = spacing && spacing.length >= 2 && spacing[1] > 0 ? spacing[0] / spacing[1] : 1;
      if (!keepView || !prev) this.fit();
      this._imageDirty = true;
      this.requestRender();
    }

    setWindow(wc, ww) {
      this.wc = wc;
      this.ww = Math.max(1, ww);
      this._imageDirty = true;
      this.requestRender();
      if (this.cb.onStateChange) this.cb.onStateChange();
    }

    setInvert(v) { this.invert = v; this._imageDirty = true; this.requestRender(); }
    setTool(t) { this.tool = t; this.canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; }

    fit() {
      if (!this.slice) return;
      const r = this.canvas.getBoundingClientRect();
      const iw = this.slice.pixels.width, ih = this.slice.pixels.height * this.aspect;
      if (!iw || !ih || !r.width || !r.height) return;
      this.zoom = Math.min(r.width / iw, r.height / ih) * 0.95;
      this.panX = 0; this.panY = 0;
      this.requestRender();
    }

    reset() {
      this.fit();
      const m = this.slice && this.slice.meta;
      if (m && m.defaultWindow) this.setWindow(m.defaultWindow.wc, m.defaultWindow.ww);
      this.invert = false;
      this._imageDirty = true;
      this.requestRender();
    }

    /* ---------- rendering ---------- */

    _buildLut(slope, intercept, mono1, signed) {
      const key = [this.wc, this.ww, slope, intercept, this.invert, mono1, signed].join('|');
      if (this.lut && this.lutKey === key) return;
      const lut = this.lut && this.lut.length === 65536 ? this.lut : new Uint8ClampedArray(65536);
      const wc = this.wc - 0.5, ww = Math.max(1, this.ww - 1);
      const flip = mono1 !== this.invert; // MONOCHROME1 XOR user invert
      for (let i = 0; i < 65536; i++) {
        // The LUT is indexed by the raw 16-bit representation. Signed values
        // use two's complement, while unsigned values retain the full 0..65535
        // range (rather than collapsing everything above 32767).
        const stored = signed && i >= 32768 ? i - 65536 : i;
        const v = stored * slope + intercept;
        let y = ((v - wc) / ww + 0.5) * 255;
        y = y < 0 ? 0 : y > 255 ? 255 : y;
        lut[i] = flip ? 255 - y : y;
      }
      this.lut = lut;
      this.lutKey = key;
    }

    _renderImage() {
      const { pixels, meta } = this.slice;
      const w = pixels.width, h = pixels.height;
      if (this.off.width !== w || this.off.height !== h) {
        this.off.width = w; this.off.height = h;
      }
      const img = this.offCtx.createImageData(w, h);
      const out = img.data;
      if (pixels.samples === 3) {
        const d = pixels.data;
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
          out[j] = d[i * 3]; out[j + 1] = d[i * 3 + 1]; out[j + 2] = d[i * 3 + 2]; out[j + 3] = 255;
        }
      } else {
        const slope = meta.rescaleSlope, intercept = meta.rescaleIntercept;
        const mono1 = meta.photometric === 'MONOCHROME1';
        this._buildLut(slope, intercept, mono1, pixels.signed);
        const lut = this.lut;
        const d = pixels.data;
        if (pixels.signed) {
          for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const y = lut[d[i] & 0xffff];
            out[j] = y; out[j + 1] = y; out[j + 2] = y; out[j + 3] = 255;
          }
        } else {
          for (let i = 0, j = 0; i < w * h; i++, j += 4) {
            const y = lut[d[i]];
            out[j] = y; out[j + 1] = y; out[j + 2] = y; out[j + 3] = 255;
          }
        }
      }
      this.offCtx.putImageData(img, 0, 0);
      this._imageDirty = false;
    }

    /** image px → canvas css px */
    imageToScreen(x, y) {
      const r = this.canvas.getBoundingClientRect();
      const cx = r.width / 2 + this.panX, cy = r.height / 2 + this.panY;
      const w = this.slice.pixels.width, h = this.slice.pixels.height;
      return {
        x: cx + (x - w / 2) * this.zoom,
        y: cy + (y - h / 2) * this.zoom * this.aspect,
      };
    }

    screenToImage(x, y) {
      const r = this.canvas.getBoundingClientRect();
      const cx = r.width / 2 + this.panX, cy = r.height / 2 + this.panY;
      const w = this.slice.pixels.width, h = this.slice.pixels.height;
      return {
        x: (x - cx) / this.zoom + w / 2,
        y: (y - cy) / (this.zoom * this.aspect) + h / 2,
      };
    }

    requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
    }

    render() {
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.slice) return;
      if (this._imageDirty) this._renderImage();

      const r = this.canvas.getBoundingClientRect();
      const w = this.slice.pixels.width, h = this.slice.pixels.height;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.save();
      ctx.translate(r.width / 2 + this.panX, r.height / 2 + this.panY);
      ctx.scale(this.zoom, this.zoom * this.aspect);
      ctx.translate(-w / 2, -h / 2);
      ctx.imageSmoothingEnabled = this.zoom < 4; // show real pixels at high zoom
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.off, 0, 0);
      ctx.restore();

      this._drawMeasurements(ctx);
      this._drawOverlays(ctx, r);
    }

    _drawMeasurements(ctx) {
      const list = this.measurements.get(this.sliceKey) || [];
      const pending = this._pendingMeasure ? [this._pendingMeasure] : [];
      const spacing = (this.slice.meta || {}).pixelSpacing;
      for (const m of [...list, ...pending]) {
        const a = this.imageToScreen(m.x0, m.y0);
        const b = this.imageToScreen(m.x1, m.y1);
        ctx.strokeStyle = '#ffd166';
        ctx.fillStyle = '#ffd166';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        for (const p of [a, b]) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
        }
        const dx = m.x1 - m.x0, dy = m.y1 - m.y0;
        let label;
        if (spacing && spacing.length >= 2) {
          const mm = Math.sqrt((dx * spacing[1]) ** 2 + (dy * spacing[0]) ** 2);
          label = mm >= 10 ? (mm / 10).toFixed(2) + ' cm' : mm.toFixed(1) + ' mm';
        } else {
          label = Math.sqrt(dx * dx + dy * dy).toFixed(1) + ' px';
        }
        ctx.font = '12px -apple-system, sans-serif';
        const tx = (a.x + b.x) / 2 + 8, ty = (a.y + b.y) / 2 - 8;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(tx - 3, ty - 12, tw + 6, 16);
        ctx.fillStyle = '#ffd166';
        ctx.fillText(label, tx, ty);
      }
    }

    _drawOverlays(ctx, r) {
      const o = this.overlay;
      ctx.font = '11px -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      const pad = 8, lh = 15;
      const drawBlock = (lines, x, y, align, up) => {
        ctx.textAlign = align;
        lines = lines.filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          const yy = up ? y - (lines.length - 1 - i) * lh : y + i * lh;
          ctx.fillStyle = 'rgba(0,0,0,0.5)';
          const tw = ctx.measureText(lines[i]).width;
          ctx.fillRect(align === 'left' ? x - 2 : x - tw - 2, yy - 1, tw + 4, 13);
          ctx.fillStyle = '#9fd3ff';
          ctx.fillText(lines[i], x, yy);
        }
      };
      drawBlock(o.topLeft || [], pad, pad, 'left', false);
      drawBlock(o.topRight || [], r.width - pad, pad, 'right', false);
      drawBlock(o.bottomLeft || [], pad, r.height - pad - 11, 'left', true);
      drawBlock(o.bottomRight || [], r.width - pad, r.height - pad - 11, 'right', true);

      // orientation markers from IOP
      const m = this.slice.meta || {};
      if (m.orientation && m.orientation.length === 6) {
        const lab = orientationLabels(m.orientation);
        ctx.fillStyle = '#ffda85';
        ctx.textAlign = 'center';
        if (lab.right) ctx.fillText(lab.right, r.width - 14, r.height / 2);
        if (lab.left) ctx.fillText(lab.left, 14, r.height / 2);
        if (lab.top) ctx.fillText(lab.top, r.width / 2, 6);
        if (lab.bottom) ctx.fillText(lab.bottom, r.width / 2, r.height - 16);
      }
    }

    /* ---------- interaction ---------- */

    _bindEvents() {
      const c = this.canvas;
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // pinch-zoom (trackpad) / ctrl+wheel
          const factor = Math.exp(-e.deltaY * 0.01);
          this._zoomAt(e.offsetX, e.offsetY, factor);
        } else {
          const delta = Math.sign(e.deltaY);
          if (delta && this.cb.onSliceRequest) this.cb.onSliceRequest(delta);
        }
      }, { passive: false });

      c.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const mid = e.button === 1;
        const right = e.button === 2;
        let mode = this.tool;
        if (mid || (this._spaceDown && e.button === 0)) mode = 'pan';
        if (right) mode = 'zoom';
        this._drag = {
          mode, x: e.offsetX, y: e.offsetY,
          wc: this.wc, ww: this.ww, panX: this.panX, panY: this.panY, zoom: this.zoom,
        };
        if (mode === 'measure' && this.slice) {
          const p = this.screenToImage(e.offsetX, e.offsetY);
          this._pendingMeasure = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        }
        if (mode === 'pan') c.style.cursor = 'grabbing';
      });

      window.addEventListener('mousemove', (e) => {
        if (!this._drag) {
          if (this.slice && this.cb.onProbe && e.target === c) {
            const p = this.screenToImage(e.offsetX, e.offsetY);
            this.cb.onProbe(this._probe(p.x, p.y));
          }
          return;
        }
        const d = this._drag;
        const rect = c.getBoundingClientRect();
        const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
        const dx = ox - d.x, dy = oy - d.y;
        if (d.mode === 'wl') {
          // horizontal: width, vertical: center; scale with current width
          const scale = Math.max(1, d.ww / 200);
          this.setWindow(d.wc + Math.round(dy * scale), d.ww + Math.round(dx * scale));
        } else if (d.mode === 'pan') {
          this.panX = d.panX + dx; this.panY = d.panY + dy;
          this.requestRender();
        } else if (d.mode === 'zoom') {
          const factor = Math.exp(-dy * 0.005);
          this.zoom = Math.min(64, Math.max(0.05, d.zoom * factor));
          this._imageDirty = false;
          this.requestRender();
          if (this.cb.onStateChange) this.cb.onStateChange();
        } else if (d.mode === 'measure' && this._pendingMeasure) {
          const p = this.screenToImage(ox, oy);
          this._pendingMeasure.x1 = p.x; this._pendingMeasure.y1 = p.y;
          this.requestRender();
        }
      });

      window.addEventListener('mouseup', () => {
        if (this._drag && this._drag.mode === 'measure' && this._pendingMeasure) {
          const m = this._pendingMeasure;
          const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
          if (len > 2) {
            if (!this.measurements.has(this.sliceKey)) this.measurements.set(this.sliceKey, []);
            this.measurements.get(this.sliceKey).push(m);
          }
          this._pendingMeasure = null;
          this.requestRender();
        }
        if (this._drag && this._drag.mode === 'pan') this.setTool(this.tool);
        this._drag = null;
      });

      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('dblclick', () => this.fit());

      window.addEventListener('keydown', (e) => { if (e.code === 'Space') this._spaceDown = true; });
      window.addEventListener('keyup', (e) => { if (e.code === 'Space') this._spaceDown = false; });
    }

    _zoomAt(sx, sy, factor) {
      const before = this.screenToImage(sx, sy);
      this.zoom = Math.min(64, Math.max(0.05, this.zoom * factor));
      const after = this.imageToScreen(before.x, before.y);
      this.panX += sx - after.x;
      this.panY += sy - after.y;
      this.requestRender();
      if (this.cb.onStateChange) this.cb.onStateChange();
    }

    _probe(ix, iy) {
      const { pixels, meta } = this.slice;
      const x = Math.floor(ix), y = Math.floor(iy);
      if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return null;
      if (pixels.samples === 3) {
        const i = (y * pixels.width + x) * 3;
        return { x, y, text: `RGB ${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}` };
      }
      const raw = pixels.data[y * pixels.width + x];
      const v = raw * meta.rescaleSlope + meta.rescaleIntercept;
      const unit = meta.modality === 'CT' ? ' HU' : '';
      return { x, y, text: `${Math.round(v)}${unit} @ (${x},${y})` };
    }

    clearMeasurements() {
      this.measurements.delete(this.sliceKey);
      this.requestRender();
    }
  }

  /** Dominant patient-axis labels for row/col direction cosines. */
  function orientationLabels(iop) {
    const label = (v) => {
      const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
      if (ax >= ay && ax >= az) return v[0] >= 0 ? 'L' : 'R';
      if (ay >= ax && ay >= az) return v[1] >= 0 ? 'P' : 'A';
      return v[2] >= 0 ? 'H' : 'F';
    };
    const flip = { L: 'R', R: 'L', A: 'P', P: 'A', H: 'F', F: 'H' };
    const row = [iop[0], iop[1], iop[2]];
    const col = [iop[3], iop[4], iop[5]];
    const right = label(row), bottom = label(col);
    return { right, left: flip[right], bottom, top: flip[bottom] };
  }

  const api = { Viewport, WINDOW_PRESETS, orientationLabels };
  global.RENDER = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
