import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { IGNORED_DIR_NAMES } from "./file-browser.ts";

/**
 * File index for the composer's `@` mention menu.
 *
 * Walks the project once per cwd (short TTL), then answers fuzzy queries. Kept
 * separate from the directory-listing route because suggestions want a flat
 * file list, not one directory at a time.
 */

export interface FileIndexEntry {
  path: string;
  isDir: boolean;
}

interface CacheEntry {
  entries: FileIndexEntry[];
  truncated: boolean;
  expiresAt: number;
}

declare global {
  var __piFileIndexCache: Map<string, CacheEntry> | undefined;
}

const CACHE_TTL_MS = 15_000;
const MAX_ENTRIES = 8000;
const MAX_DEPTH = 12;

const EXTRA_IGNORED = new Set([
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
  "release",
  "out",
  ".turbo",
  ".next",
]);

function cache(): Map<string, CacheEntry> {
  if (!globalThis.__piFileIndexCache) globalThis.__piFileIndexCache = new Map();
  return globalThis.__piFileIndexCache;
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  entries: FileIndexEntry[],
): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
  let children: Dirent[];
  try {
    children = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  children.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const child of children) {
    if (entries.length >= MAX_ENTRIES) return;
    if (child.name.startsWith(".") && child.name !== ".pi") continue;
    const full = path.join(dir, child.name);
    let isDir = child.isDirectory();
    if (child.isSymbolicLink()) {
      // Avoid symlink cycles: only descend into directory links that stay inside.
      const info = await fs.stat(full).catch(() => null);
      if (!info?.isDirectory()) continue;
      const real = await fs.realpath(full).catch(() => null);
      if (!real) continue;
      const relative = path.relative(root, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      isDir = true;
    }
    if (isDir && (IGNORED_DIR_NAMES.has(child.name) || EXTRA_IGNORED.has(child.name))) continue;
    const relative = path.relative(root, full).replace(/\\/g, "/");
    entries.push({ path: relative, isDir });
    if (isDir) await walk(root, full, depth + 1, entries);
  }
}

export async function buildFileIndex(
  cwd: string,
): Promise<{ entries: FileIndexEntry[]; truncated: boolean }> {
  const key = path.resolve(cwd);
  const cached = cache().get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { entries: cached.entries, truncated: cached.truncated };
  }
  const entries: FileIndexEntry[] = [];
  await walk(key, key, 0, entries);
  const result = { entries, truncated: entries.length >= MAX_ENTRIES };
  cache().set(key, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** Substring + character-subsequence score; higher is better, 0 = no match. */
export function fuzzyScore(candidate: string, query: string): number {
  const value = candidate.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 1;
  const direct = value.lastIndexOf(needle);
  if (direct !== -1) {
    // Prefer basename matches and shorter paths.
    const base = value.split("/").pop() ?? value;
    const baseHit = base.includes(needle) ? 400 : 0;
    return 1000 + baseHit + Math.max(0, 200 - direct) - value.length;
  }
  let index = 0;
  let gaps = 0;
  let last = -1;
  for (const char of needle) {
    const found = value.indexOf(char, index);
    if (found === -1) return 0;
    if (last !== -1) gaps += found - last - 1;
    last = found;
    index = found + 1;
  }
  return 400 - gaps - value.length;
}

export function searchFileIndex(
  entries: FileIndexEntry[],
  query: string,
  limit = 20,
): FileIndexEntry[] {
  const trimmed = query.replace(/^@/, "").trim();
  if (!trimmed) {
    // Empty query: show the shallowest entries (root-level browsing).
    const sorted = [...entries].sort((a, b) => {
      const depth = (p: string) => p.split("/").length;
      if (depth(a.path) !== depth(b.path)) return depth(a.path) - depth(b.path);
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
    return sorted.slice(0, limit);
  }

  // `dir/` browse mode: direct children of that directory.
  if (trimmed.endsWith("/")) {
    const prefix = trimmed.toLowerCase();
    return entries
      .filter((entry) => entry.path.toLowerCase().startsWith(prefix))
      .filter((entry) => !entry.path.slice(prefix.length).includes("/"))
      .slice(0, limit);
  }

  return entries
    .map((entry) => ({ entry, score: fuzzyScore(entry.path, trimmed) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
      return a.entry.path.length - b.entry.path.length;
    })
    .slice(0, limit)
    .map((item) => item.entry);
}
