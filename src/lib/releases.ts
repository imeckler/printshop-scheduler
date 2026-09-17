// Desktop app downloads. The installers are built by riso-utils' GitHub
// Actions workflow and attached to GitHub releases tagged desktop-v*. That
// repo is private, so this module lists the latest release through the GitHub
// API with RISO_UTILS_GITHUB_TOKEN and streams the assets to the browser;
// nothing is copied into this repo.
import { Readable } from 'stream';

const REPO = 'imeckler/riso-utils';
const TAG_PREFIX = 'desktop-v';
const CACHE_MS = 10 * 60 * 1000;
const API = 'https://api.github.com';

export type Platform = 'mac' | 'windows' | 'linux';

export interface DesktopAsset {
  id: number;
  name: string;
  size: number;
  platform: Platform;
  /** e.g. "Apple silicon & Intel", "64-bit" */
  arch: string;
  /** "dmg", "zip", "exe", "AppImage" */
  kind: string;
}

export interface DesktopRelease {
  version: string;
  tag: string;
  publishedAt: string;
  notes: string;
  assets: DesktopAsset[];
}

interface GhAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  assets: GhAsset[];
}

function token(): string | null {
  return process.env.RISO_UTILS_GITHUB_TOKEN || null;
}

export function downloadsConfigured(): boolean {
  return token() !== null;
}

function headers(accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token()}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'printshop-scheduler',
  };
}

/** Map an installer's file name (see desktop/electron-builder.yml artifactName) to a platform. */
export function classifyAsset(a: GhAsset): DesktopAsset | null {
  const m = /^riso-layout-[\w.-]+?-(mac|win|linux)-(universal|x64|arm64)\.(dmg|zip|exe|AppImage)$/.exec(
    a.name
  );
  if (!m) return null;
  const [, os, arch, kind] = m;
  const platform: Platform = os === 'mac' ? 'mac' : os === 'win' ? 'windows' : 'linux';
  const archLabel =
    arch === 'universal' ? 'Apple silicon & Intel' : arch === 'arm64' ? 'ARM 64-bit' : '64-bit';
  return { id: a.id, name: a.name, size: a.size, platform, arch: archLabel, kind };
}

let cache: { at: number; release: DesktopRelease | null } | null = null;

/** The newest published desktop-v* release, or null if there is none (cached). */
export async function latestDesktopRelease(): Promise<DesktopRelease | null> {
  if (!token()) return null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.release;
  const res = await fetch(`${API}/repos/${REPO}/releases?per_page=30`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const releases = (await res.json()) as GhRelease[];
  const rel = releases.find(r => !r.draft && !r.prerelease && r.tag_name.startsWith(TAG_PREFIX));
  const release: DesktopRelease | null = rel
    ? {
        version: rel.tag_name.slice(TAG_PREFIX.length),
        tag: rel.tag_name,
        publishedAt: rel.published_at ?? '',
        notes: rel.body ?? '',
        assets: rel.assets.map(classifyAsset).filter((a): a is DesktopAsset => a !== null),
      }
    : null;
  cache = { at: Date.now(), release };
  return release;
}

export function clearReleaseCache() {
  cache = null;
}

export interface AssetStream {
  name: string;
  size: number | null;
  contentType: string;
  body: Readable;
}

/**
 * Open an installer for streaming. `id` must belong to the current release
 * (so the route can't be used to fetch arbitrary private assets). GitHub
 * answers the asset URL with a redirect to a signed storage URL; that one
 * must be fetched *without* the Authorization header.
 */
export async function openAsset(id: number): Promise<AssetStream | null> {
  const release = await latestDesktopRelease();
  const asset = release?.assets.find(a => a.id === id);
  if (!asset) return null;
  const first = await fetch(`${API}/repos/${REPO}/releases/assets/${id}`, {
    headers: headers('application/octet-stream'),
    redirect: 'manual',
  });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location');
    if (!location) throw new Error('GitHub asset redirect without location');
    res = await fetch(location);
  }
  if (!res.ok || !res.body) throw new Error(`GitHub asset download: HTTP ${res.status}`);
  const len = res.headers.get('content-length');
  return {
    name: asset.name,
    size: len ? parseInt(len, 10) : null,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    body: Readable.fromWeb(res.body as import('stream/web').ReadableStream),
  };
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  mac: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

export function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
