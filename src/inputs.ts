import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SUPPORTED_FORMATS = ['woff2', 'woff', 'ttf', 'eot', 'svg'];
export const FONT_DISPLAY_VALUES = ['auto', 'block', 'swap', 'fallback', 'optional'];

/** Comma- or newline-separated values, trimmed, without empties or repeats. */
export function parseList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== ''))];
}

export function parseFormats(value: string): string[] {
  const formats = parseList(value.toLowerCase());
  if (formats.length === 0) {
    return ['woff2'];
  }
  const unknown = formats.filter((format) => !SUPPORTED_FORMATS.includes(format));
  if (unknown.length > 0) {
    throw new Error(`Input formats has unsupported ${unknown.join(', ')}; use any of ${SUPPORTED_FORMATS.join(', ')}.`);
  }
  return formats;
}

export function parseFontDisplay(value: string): string {
  const normalized = value.trim().toLowerCase() || 'swap';
  if (!FONT_DISPLAY_VALUES.includes(normalized)) {
    throw new Error(`Input font-display must be one of ${FONT_DISPLAY_VALUES.join(', ')}, got "${value}".`);
  }
  return normalized;
}

export function parseTimeoutMinutes(value: string): number {
  const minutes = Number(value.trim() || '10');
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Input timeout-minutes must be a positive number, got "${value}".`);
  }
  return minutes;
}

const isInside = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return !(fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot));
};

/** Resolves `value` against the workspace and refuses a path that leaves it. */
export function resolveInsideWorkspace(workspace: string, value: string, inputName: string): string {
  const path = resolve(workspace, value);
  if (!isInside(resolve(workspace), path)) {
    throw new Error(`Input ${inputName} must be inside the workspace, got "${value}".`);
  }
  return path;
}

/** The real path of the nearest existing ancestor (symlinks resolved), with the missing rest appended. */
async function realPathOfNearestExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === current) {
        throw error;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Refuses a directory that the lexical check accepted but that leads outside the workspace through a symlink. */
export async function assertRealPathInsideWorkspace(
  workspace: string,
  directory: string,
  value: string,
  inputName: string,
): Promise<void> {
  const [realWorkspace, realDirectory] = await Promise.all([
    realPathOfNearestExisting(workspace),
    realPathOfNearestExisting(directory),
  ]);
  if (!isInside(realWorkspace, realDirectory)) {
    throw new Error(
      `Input ${inputName} must be inside the workspace, got "${value}" (it leads outside through a symbolic link).`,
    );
  }
}

export const DEFAULT_API_URL = 'https://font.rest/api/v1';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Empty falls back to the default; only https is accepted, or http to localhost / 127.0.0.1. */
export function parseApiUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    return DEFAULT_API_URL;
  }
  let url: URL | undefined;
  try {
    url = new URL(trimmed);
  } catch {
    url = undefined;
  }
  const allowed = url !== undefined && (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)));
  if (!allowed) {
    throw new Error(
      `Input api-url must be an https URL (http is allowed only for localhost and 127.0.0.1), got "${value}".`,
    );
  }
  return trimmed;
}
