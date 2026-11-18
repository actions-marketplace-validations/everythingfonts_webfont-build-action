import { isAbsolute, relative, resolve, sep } from 'node:path';

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

/** Resolves `value` against the workspace and refuses a path that leaves it. */
export function resolveInsideWorkspace(workspace: string, value: string, inputName: string): string {
  const path = resolve(workspace, value);
  const fromWorkspace = relative(resolve(workspace), path);
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
    throw new Error(`Input ${inputName} must be inside the workspace, got "${value}".`);
  }
  return path;
}
