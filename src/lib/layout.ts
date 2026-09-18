// Thin wrapper around the `riso-layout` binary (from the riso-utils repo,
// built in the Dockerfile). All layout maths and colour separation happen in
// Rust; this module only passes options through, parses the JSON it prints,
// and manages the per-request output directories ("jobs").
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface InkInfo {
  name: string;
  rgb: [number, number, number];
  family: string;
}

export interface Placement {
  x: number;
  y: number;
}

/** What is being tiled: a raster image (pixels) or a vector PDF page (inches). */
export type LayoutSource = { kind: 'pixels'; w: number; h: number } | { kind: 'inches'; w: number; h: number };

export interface Layout {
  source: LayoutSource;
  copies: number;
  cols: number;
  rows: number;
  rotated: boolean;
  copy_w: number;
  copy_h: number;
  cell_w: number;
  cell_h: number;
  grid_w: number;
  grid_h: number;
  margin: number;
  /** Effective print resolution; null for vector (PDF) sources. */
  dpi: number | null;
  paper_w: number;
  paper_h: number;
  printable_w: number;
  printable_h: number;
  placements: Placement[];
}

export interface LayoutErrorInfo {
  kind: 'invalid' | 'too_large' | 'too_many' | 'over_cap';
  message: string;
  max_w?: number;
  max_h?: number;
  requested?: number;
  max?: number | null;
  copies?: number;
  cap?: number;
}

export type LayoutGoal =
  | { kind: 'width'; value: number }
  | { kind: 'height'; value: number }
  | { kind: 'copies'; value: number };

export interface LayoutRequest {
  margin: number;
  allowRotate: boolean;
  goal: LayoutGoal;
}

export type PlanResult = { ok: true; layout: Layout } | { ok: false; error: LayoutErrorInfo };

export interface PlateInfo {
  index: number;
  ink: string;
  rgb: [number, number, number];
  file: string;
  /** Ink coverage 0..1; null for vector (PDF) sources. */
  density: number | null;
}

export interface RenderOutput {
  layout: Layout;
  plates: PlateInfo[];
  preview_pdf: string | null;
  /** Only produced for raster input. */
  preview_png: string | null;
  /** PDF features the separator left untouched, and multi-page notices. */
  warnings: string[];
  /** Page count of a PDF input (only the first page is laid out). */
  pages: number | null;
}

export type RenderResult =
  | { ok: true; result: RenderOutput }
  | { ok: false; error: LayoutErrorInfo };

// ---- locating and running the binary ----

const repoRoot = path.join(__dirname, '..', '..');

const candidateBinaries = () => [
  process.env.RISO_LAYOUT_BIN,
  '/usr/local/bin/riso-layout',
  path.join(repoRoot, '..', 'spectrolite', 'spectrolite-sep', 'target', 'release', 'riso-layout'),
];

let resolvedBinary: string | null = null;

/** Path to riso-layout, or throws with a hint on how to get one. */
export function resolveBinary(): string {
  if (resolvedBinary) return resolvedBinary;
  for (const c of candidateBinaries()) {
    if (c && fs.existsSync(c)) {
      resolvedBinary = c;
      return c;
    }
  }
  throw new Error(
    'riso-layout binary not found. Set RISO_LAYOUT_BIN, or build it with ' +
      '`cargo build --release --bin riso-layout` in a riso-utils checkout.'
  );
}

export function binaryAvailable(): boolean {
  try {
    resolveBinary();
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs: number): Promise<RunResult> {
  const bin = resolveBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`riso-layout ${args[0]} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Exit code 2 = bad invocation / unreadable input; surface stderr as the error. */
function usageError(r: RunResult, what: string): Error {
  const msg = r.stderr.trim().split('\n').pop() || `riso-layout ${what} failed (exit ${r.code})`;
  return new Error(msg.replace(/^error:\s*/, ''));
}

function parseJson<T>(r: RunResult, what: string): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`riso-layout ${what} produced no JSON (exit ${r.code}): ${r.stderr.trim()}`);
  }
}

// ---- commands ----

let inkCache: Promise<InkInfo[]> | null = null;

/** The full RISO ink table known to the binary (cached for the process lifetime). */
export function listInks(): Promise<InkInfo[]> {
  if (!inkCache) {
    inkCache = run(['inks'], 20_000)
      .then(r => {
        if (r.code !== 0) throw usageError(r, 'inks');
        return parseJson<InkInfo[]>(r, 'inks');
      })
      .catch(err => {
        inkCache = null;
        throw err;
      });
  }
  return inkCache;
}

export const rgbToHex = (rgb: [number, number, number]) =>
  '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

function finite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

function goalArgs(req: LayoutRequest): string[] {
  const args = ['--margin', String(finite(req.margin, 'margin'))];
  const v = finite(req.goal.value, req.goal.kind);
  switch (req.goal.kind) {
    case 'width':
      args.push('--width', String(v));
      break;
    case 'height':
      args.push('--height', String(v));
      break;
    case 'copies':
      if (!Number.isInteger(v)) throw new Error('copies must be a whole number');
      args.push('--copies', String(v));
      break;
    default:
      throw new Error('unknown goal');
  }
  if (!req.allowRotate) args.push('--no-rotate');
  return args;
}

/** Layout only (no file decoding): fast enough to call on every form change. */
export async function planLayout(source: LayoutSource, req: LayoutRequest): Promise<PlanResult> {
  const { w, h } = source;
  let sourceArgs: string[];
  if (source.kind === 'pixels') {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      throw new Error('image size must be positive integers');
    }
    sourceArgs = ['--image-px', `${w}x${h}`];
  } else {
    if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) {
      throw new Error('page size must be positive');
    }
    sourceArgs = ['--size-in', `${w}x${h}`];
  }
  const r = await run(['plan', ...sourceArgs, ...goalArgs(req)], 20_000);
  if (r.code === 2 || (r.code !== 0 && r.code !== 1)) throw usageError(r, 'plan');
  return parseJson<PlanResult>(r, 'plan');
}

/** Separate `imagePath` (PNG, JPEG or PDF) into the given inks and write the plates into `outDir`. */
export async function renderLayout(
  imagePath: string,
  outDir: string,
  inkNames: string[],
  req: LayoutRequest
): Promise<RenderResult> {
  if (inkNames.length < 1 || inkNames.length > 4) throw new Error('choose between 1 and 4 inks');
  const args = [
    'render',
    '-i',
    imagePath,
    '-o',
    outDir,
    '--inks',
    inkNames.join(','),
    ...goalArgs(req),
  ];
  const r = await run(args, 10 * 60_000);
  if (r.code === 2 || (r.code !== 0 && r.code !== 1)) throw usageError(r, 'render');
  const parsed = parseJson<
    ({ ok: true } & RenderOutput) | { ok: false; error: LayoutErrorInfo }
  >(r, 'render');
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, result: parsed };
}

// ---- jobs: one temp directory per render, owned by the user who made it ----

const JOB_ROOT = path.join(os.tmpdir(), 'printshop-layout');
const JOB_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const JOB_ID_RE = /^[a-f0-9]{24}$/;
const JOB_FILE_RE = /^[a-z0-9][a-z0-9.-]*\.(pdf|png)$/;
export type UploadKind = 'png' | 'jpg' | 'pdf';

export function createJobDir(userId: number): { id: string; dir: string } {
  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(JOB_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner'), String(userId));
  return { id, dir };
}

/** Absolute path of an output file if the job exists, belongs to `userId`, and the name is sane. */
export function jobFilePath(jobId: string, userId: number, file: string): string | null {
  if (!JOB_ID_RE.test(jobId) || !JOB_FILE_RE.test(file)) return null;
  const dir = path.join(JOB_ROOT, jobId);
  try {
    if (fs.readFileSync(path.join(dir, 'owner'), 'utf-8').trim() !== String(userId)) return null;
    const full = path.join(dir, file);
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function removeJobDir(jobId: string) {
  if (!JOB_ID_RE.test(jobId)) return;
  fs.rmSync(path.join(JOB_ROOT, jobId), { recursive: true, force: true });
}

function cleanupJobs() {
  let entries: string[];
  try {
    entries = fs.readdirSync(JOB_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - JOB_MAX_AGE_MS;
  for (const name of entries) {
    if (!JOB_ID_RE.test(name)) continue;
    const dir = path.join(JOB_ROOT, name);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;

/** Delete render outputs older than a few hours, hourly. */
export function startJobCleanup() {
  if (cleanupTimer) return;
  cleanupJobs();
  cleanupTimer = setInterval(cleanupJobs, 60 * 60 * 1000);
  cleanupTimer.unref();
}

/** 'png' | 'jpg' | 'pdf' from the file's magic bytes, or null for anything else. */
export function sniffImageType(buf: Buffer): UploadKind | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 5 && buf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  return null;
}
