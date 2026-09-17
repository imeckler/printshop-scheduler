// /layout page: collect the image + options, show the sheet layout computed by
// the server (riso-layout binary) live, and request the plate PDFs.

interface InkOption {
  name: string;
  hex: string;
}

interface LayoutConfig {
  inks: InkOption[];
  paper: { w: number; h: number };
  printable: { w: number; h: number };
  maxInks: number;
}

interface Placement {
  x: number;
  y: number;
}

interface Layout {
  image_px: [number, number];
  copies: number;
  cols: number;
  rows: number;
  rotated: boolean;
  copy_w: number;
  copy_h: number;
  cell_w: number;
  cell_h: number;
  dpi: number;
  paper_w: number;
  paper_h: number;
  printable_w: number;
  printable_h: number;
  placements: Placement[];
}

interface LayoutError {
  kind: string;
  message: string;
  max_w?: number;
  max_h?: number;
  max?: number | null;
}

type PlanResponse = { ok: true; layout: Layout } | { ok: false; error: LayoutError };

interface RenderResponse {
  ok: boolean;
  error?: LayoutError | string;
  jobId?: string;
  layout?: Layout;
  plates?: { ink: string; hex: string; density: number; url: string; file: string }[];
  previewPdf?: string | null;
  previewPng?: string | null;
}

declare global {
  interface Window {
    LAYOUT_CONFIG: LayoutConfig;
  }
}

const RECOMMENDED_DPI = 300;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

class LayoutPage {
  private config = window.LAYOUT_CONFIG;
  private fileInput = $<HTMLInputElement>('imageFile');
  private imageInfo = $<HTMLElement>('imageInfo');
  private marginInput = $<HTMLInputElement>('margin');
  private rotateInput = $<HTMLInputElement>('allowRotate');
  private widthInput = $<HTMLInputElement>('width');
  private heightInput = $<HTMLInputElement>('height');
  private copiesInput = $<HTMLInputElement>('copies');
  private sizeInputs = $<HTMLElement>('sizeInputs');
  private copiesInputs = $<HTMLElement>('copiesInputs');
  private summary = $<HTMLElement>('planSummary');
  private preview = $<HTMLElement>('sheetPreview');
  private renderBtn = $<HTMLButtonElement>('renderBtn');
  private renderStatus = $<HTMLElement>('renderStatus');
  private results = $<HTMLElement>('results');
  private plateList = $<HTMLElement>('plateList');
  private previewImage = $<HTMLImageElement>('previewImage');
  private previewPdfLink = $<HTMLAnchorElement>('previewPdfLink');

  /** The image as it will be uploaded (PNG/JPEG), plus its pixel size and a URL for the preview. */
  private image: { blob: Blob; name: string; w: number; h: number; url: string } | null = null;
  private layout: Layout | null = null;
  /** Which of width/height the user last typed; the other one follows the aspect ratio. */
  private sizeDriver: 'width' | 'height' = 'width';
  private planTimer: number | null = null;
  private planSeq = 0;

  constructor() {
    this.fileInput.addEventListener('change', () => this.onFile());
    this.marginInput.addEventListener('input', () => this.schedulePlan());
    this.rotateInput.addEventListener('change', () => this.schedulePlan());
    this.copiesInput.addEventListener('input', () => this.schedulePlan());
    this.widthInput.addEventListener('input', () => {
      this.sizeDriver = 'width';
      this.syncSize();
      this.schedulePlan();
    });
    this.heightInput.addEventListener('input', () => {
      this.sizeDriver = 'height';
      this.syncSize();
      this.schedulePlan();
    });
    document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach(r =>
      r.addEventListener('change', () => {
        const copies = this.mode() === 'copies';
        this.sizeInputs.style.display = copies ? 'none' : '';
        this.copiesInputs.style.display = copies ? '' : 'none';
        this.schedulePlan();
      })
    );
    document
      .querySelectorAll<HTMLInputElement>('input[name="inks"]')
      .forEach(cb => cb.addEventListener('change', () => this.onInksChanged()));
    this.renderBtn.addEventListener('click', () => this.render());
    this.drawSheet(null);
    this.onInksChanged();
  }

  private mode(): 'size' | 'copies' {
    const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
    return checked?.value === 'copies' ? 'copies' : 'size';
  }

  private selectedInks(): string[] {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="inks"]:checked')
    ).map(cb => cb.value);
  }

  private onInksChanged() {
    const n = this.selectedInks().length;
    document.querySelectorAll<HTMLInputElement>('input[name="inks"]').forEach(cb => {
      cb.disabled = !cb.checked && n >= this.config.maxInks;
    });
    this.updateRenderButton();
  }

  // ---- image ----

  private async onFile() {
    const file = this.fileInput.files?.[0];
    if (this.image) URL.revokeObjectURL(this.image.url);
    this.image = null;
    this.layout = null;
    if (!file) {
      this.imageInfo.textContent = 'No image selected.';
      this.drawSheet(null);
      this.updateRenderButton();
      return;
    }
    this.imageInfo.textContent = 'Reading image…';
    try {
      const { blob, w, h } = await this.prepareImage(file);
      this.image = { blob, name: file.name, w, h, url: URL.createObjectURL(blob) };
      this.imageInfo.textContent = `${file.name}: ${w} × ${h} px`;
      // Default size: fit the width of the printable area, or keep what the user typed.
      if (!this.widthInput.value && !this.heightInput.value) {
        this.widthInput.value = fmt(Math.min(4, this.config.printable.w));
        this.sizeDriver = 'width';
      }
      this.syncSize();
      this.schedulePlan();
    } catch (err) {
      this.imageInfo.textContent = `Could not read image: ${(err as Error).message}`;
      this.drawSheet(null);
    }
    this.updateRenderButton();
  }

  /** Decode in the browser to learn the size; re-encode anything that isn't PNG/JPEG as PNG. */
  private async prepareImage(file: File): Promise<{ blob: Blob; w: number; h: number }> {
    const bitmap = await createImageBitmap(file);
    const { width: w, height: h } = bitmap;
    if (file.type === 'image/png' || file.type === 'image/jpeg') {
      bitmap.close();
      return { blob: file, w, h };
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not convert image to PNG');
    return { blob, w, h };
  }

  private syncSize() {
    if (!this.image) return;
    const aspect = this.image.w / this.image.h;
    if (this.sizeDriver === 'width') {
      const w = parseFloat(this.widthInput.value);
      this.heightInput.value = w > 0 ? fmt(w / aspect, 3) : '';
    } else {
      const h = parseFloat(this.heightInput.value);
      this.widthInput.value = h > 0 ? fmt(h * aspect, 3) : '';
    }
  }

  // ---- planning ----

  private schedulePlan() {
    if (this.planTimer !== null) window.clearTimeout(this.planTimer);
    this.planTimer = window.setTimeout(() => this.plan(), 200);
  }

  private request(): Record<string, unknown> | string {
    const margin = parseFloat(this.marginInput.value);
    if (!(margin >= 0)) return 'Enter a margin of 0 or more.';
    let goal: { kind: string; value: number };
    if (this.mode() === 'copies') {
      const n = parseInt(this.copiesInput.value, 10);
      if (!(n >= 1)) return 'Enter how many copies you want.';
      goal = { kind: 'copies', value: n };
    } else if (this.sizeDriver === 'width') {
      const w = parseFloat(this.widthInput.value);
      if (!(w > 0)) return 'Enter a width or height for each copy.';
      goal = { kind: 'width', value: w };
    } else {
      const h = parseFloat(this.heightInput.value);
      if (!(h > 0)) return 'Enter a width or height for each copy.';
      goal = { kind: 'height', value: h };
    }
    return { margin, allowRotate: this.rotateInput.checked, goal };
  }

  private async plan() {
    this.layout = null;
    if (!this.image) {
      this.summary.textContent = '';
      this.updateRenderButton();
      return;
    }
    const req = this.request();
    if (typeof req === 'string') {
      this.summary.textContent = req;
      this.drawSheet(null);
      this.updateRenderButton();
      return;
    }
    const seq = ++this.planSeq;
    try {
      const res = await fetch('/layout/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ widthPx: this.image.w, heightPx: this.image.h, ...req }),
      });
      if (seq !== this.planSeq) return;
      if (!res.ok)
        throw new Error(
          res.status === 403 ? 'Your session has expired; reload the page.' : `HTTP ${res.status}`
        );
      const data = (await res.json()) as PlanResponse;
      if (seq !== this.planSeq) return;
      if (data.ok) {
        this.layout = data.layout;
        this.showSummary(data.layout);
        this.drawSheet(data.layout);
      } else {
        this.summary.innerHTML = `<span class="text-danger">${escapeHtml(data.error.message)}</span>`;
        this.drawSheet(null);
      }
    } catch (err) {
      if (seq !== this.planSeq) return;
      this.summary.innerHTML = `<span class="text-danger">${escapeHtml((err as Error).message)}</span>`;
      this.drawSheet(null);
    }
    this.updateRenderButton();
  }

  private showSummary(l: Layout) {
    const parts = [
      `<strong>${l.copies} ${l.copies === 1 ? 'copy' : 'copies'}</strong> per sheet in a ${l.cols} × ${l.rows} grid${l.rotated ? ' (rotated 90°)' : ''}`,
      `each ${fmt(l.copy_w, 3)} × ${fmt(l.copy_h, 3)} in`,
      `${Math.round(l.dpi)} dpi`,
    ];
    let warn = '';
    if (l.dpi < RECOMMENDED_DPI) {
      warn = `<div class="text-warning">Low resolution: ${Math.round(l.dpi)} dpi at this size. ${RECOMMENDED_DPI}+ dpi is recommended for crisp prints; use a smaller size or a larger image.</div>`;
    }
    this.summary.innerHTML = parts.join(' · ') + warn;
  }

  // ---- preview ----

  private drawSheet(l: Layout | null) {
    const { paper, printable } = this.config;
    const pw = l ? l.paper_w : paper.w;
    const ph = l ? l.paper_h : paper.h;
    const prw = l ? l.printable_w : printable.w;
    const prh = l ? l.printable_h : printable.h;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${pw} ${ph}`);
    svg.setAttribute('class', 'sheet-svg');
    const rect = (x: number, y: number, w: number, h: number, cls: string) => {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', String(w));
      r.setAttribute('height', String(h));
      r.setAttribute('class', cls);
      return r;
    };
    svg.appendChild(rect(0, 0, pw, ph, 'sheet-paper'));
    svg.appendChild(rect((pw - prw) / 2, (ph - prh) / 2, prw, prh, 'sheet-printable'));
    if (l && this.image) {
      for (const p of l.placements) {
        const g = document.createElementNS(ns, 'g');
        g.setAttribute('transform', `translate(${p.x} ${p.y})`);
        const img = document.createElementNS(ns, 'image');
        img.setAttribute('href', this.image.url);
        img.setAttribute('width', String(l.copy_w));
        img.setAttribute('height', String(l.copy_h));
        img.setAttribute('preserveAspectRatio', 'none');
        if (l.rotated) {
          // 90° anticlockwise, matching the PDF: the image's top edge runs up the cell's left side.
          img.setAttribute('transform', `translate(0 ${l.copy_w}) rotate(-90)`);
        }
        g.appendChild(img);
        g.appendChild(rect(0, 0, l.cell_w, l.cell_h, 'sheet-cell'));
        svg.appendChild(g);
      }
    }
    this.preview.replaceChildren(svg);
  }

  // ---- rendering ----

  private updateRenderButton() {
    const ready = !!this.image && !!this.layout && this.selectedInks().length > 0;
    this.renderBtn.disabled = !ready;
  }

  private async render() {
    if (!this.image || !this.layout) return;
    const req = this.request();
    if (typeof req === 'string') return;
    const inks = this.selectedInks();
    const form = new FormData();
    form.append('margin', String(req.margin));
    form.append('allowRotate', String(req.allowRotate));
    const goal = req.goal as { kind: string; value: number };
    form.append('goalKind', goal.kind);
    form.append('goalValue', String(goal.value));
    form.append('inks', inks.join(','));
    const ext = this.image.blob.type === 'image/jpeg' ? 'jpg' : 'png';
    form.append('image', this.image.blob, `image.${ext}`);

    this.renderBtn.disabled = true;
    this.renderStatus.textContent = `Separating into ${inks.length} ink${inks.length > 1 ? 's' : ''} and building PDFs… this can take a little while for large images.`;
    this.results.style.display = 'none';
    try {
      const res = await fetch('/layout/render', { method: 'POST', body: form });
      let data: RenderResponse;
      try {
        data = (await res.json()) as RenderResponse;
      } catch {
        throw new Error(
          res.status === 403 ? 'Your session has expired; reload the page.' : `HTTP ${res.status}`
        );
      }
      if (!res.ok || !data.ok) {
        const e = data.error;
        throw new Error(typeof e === 'string' ? e : e?.message || `HTTP ${res.status}`);
      }
      this.showResults(data);
      this.renderStatus.textContent = '';
    } catch (err) {
      this.renderStatus.innerHTML = `<span class="text-danger">${escapeHtml((err as Error).message)}</span>`;
    }
    this.updateRenderButton();
  }

  private showResults(data: RenderResponse) {
    this.plateList.replaceChildren();
    for (const p of data.plates || []) {
      const li = document.createElement('li');
      li.className = 'plate-item';
      li.innerHTML =
        `<span class="ink-swatch" style="background: ${escapeHtml(p.hex)}"></span>` +
        `<span class="plate-name">${escapeHtml(p.ink)} <code class="ink-hex">${escapeHtml(p.hex)}</code></span>` +
        `<span class="plate-density">${(p.density * 100).toFixed(1)}% coverage</span>` +
        `<a class="btn btn-sm btn-primary" href="${escapeHtml(p.url)}" target="_blank">Open PDF</a>` +
        `<a class="btn btn-sm btn-secondary" href="${escapeHtml(p.url)}?download=1">Download</a>`;
      this.plateList.appendChild(li);
    }
    if (data.previewPng) {
      this.previewImage.src = data.previewPng;
      this.previewImage.style.display = '';
    } else {
      this.previewImage.style.display = 'none';
    }
    if (data.previewPdf) {
      this.previewPdfLink.href = data.previewPdf;
      this.previewPdfLink.style.display = '';
    } else {
      this.previewPdfLink.style.display = 'none';
    }
    this.results.style.display = '';
    this.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

document.addEventListener('DOMContentLoaded', () => new LayoutPage());

export {};
