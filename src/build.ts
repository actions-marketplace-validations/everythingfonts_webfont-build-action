import * as core from '@actions/core';
import { strFromU8, unzipSync } from 'fflate';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { EfApiError, type EfApi } from './api';
import { mergeStylesheets } from './css';

export type BuildApi = Pick<EfApi, 'uploadFont' | 'subset' | 'fontfaceKit' | 'waitForKit' | 'kitStatus' | 'download'>;

export interface BuildOptions {
  formats: string[];
  subset: string[];
  outputDir: string;
  cssFile: string;
  fontDisplay: string;
  timeoutMs: number;
}

export interface BuildResult {
  files: string[];
  cssPath: string;
}

interface Kit {
  fonts: Map<string, Uint8Array>;
  stylesheet: string;
}

const EXPIRED_LINK_STATUSES = [403, 410];

/** The last path segment of a zip entry name: entry names are never trusted as paths. */
const entryBaseName = (name: string): string => name.split(/[\\/]/).pop() ?? '';

/** Keeps the requested font files and the stylesheet; everything else (demo.html, …) is dropped. */
function readKit(zip: Uint8Array, formats: string[], sourceName: string): Kit {
  const fonts = new Map<string, Uint8Array>();
  let stylesheet: string | undefined;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw new Error(`${sourceName}: the downloaded kit is not a valid zip file.`);
  }
  for (const [name, bytes] of Object.entries(entries)) {
    const base = entryBaseName(name);
    if (base.toLowerCase() === 'stylesheet.css') {
      stylesheet = strFromU8(bytes);
      continue;
    }
    const format = extname(base).slice(1).toLowerCase();
    if (format !== '' && formats.includes(format)) {
      fonts.set(base, bytes);
    }
  }
  if (stylesheet === undefined) {
    throw new Error(`${sourceName}: the built kit has no stylesheet.css.`);
  }
  for (const format of formats) {
    if (![...fonts.keys()].some((name) => name.toLowerCase().endsWith(`.${format}`))) {
      core.warning(`${sourceName}: the built kit has no ${format} file; your API plan may not include that format.`);
    }
  }
  return { fonts, stylesheet };
}

/** A failed download is not a key problem: the API error type is dropped so it is not read as one. */
const downloadFailure = (error: unknown): Error => new Error(error instanceof Error ? error.message : String(error));

/** Downloads the kit; an expired link (403/410) is refreshed once through the kit status. */
async function downloadKit(api: BuildApi, kitId: string, url: string): Promise<Uint8Array> {
  try {
    return await api.download(url);
  } catch (error) {
    if (!(error instanceof EfApiError) || !EXPIRED_LINK_STATUSES.includes(error.status)) {
      throw downloadFailure(error);
    }
  }
  const kit = await api.kitStatus(kitId);
  if (kit.downloadurl === null) {
    throw new Error(`The download link of kit ${kitId} expired and no fresh link is available (${kit.status}).`);
  }
  try {
    return await api.download(kit.downloadurl);
  } catch (error) {
    throw downloadFailure(error);
  }
}

async function buildKit(
  api: BuildApi,
  source: string,
  options: BuildOptions,
  deadline: number,
  tempDir: () => Promise<string>,
): Promise<Kit> {
  const sourceName = basename(source);
  core.info(`Building ${sourceName}`);
  let fontId = await api.uploadFont(source);
  if (options.subset.length > 0) {
    const bytes = await api.subset(fontId, options.subset);
    const subsetPath = join(await mkdtemp(join(await tempDir(), 'subset-')), sourceName);
    await writeFile(subsetPath, bytes);
    fontId = await api.uploadFont(subsetPath);
  }
  const kitId = await api.fontfaceKit(fontId, options.formats);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`Timed out after ${Math.round(options.timeoutMs / 60000)} minutes before ${sourceName} was built.`);
  }
  const url = await api.waitForKit(kitId, { timeoutMs: remaining });
  return readKit(await downloadKit(api, kitId, url), options.formats, sourceName);
}

/** Throws when `path` exists as a symbolic link: writing would follow it, possibly out of the workspace. */
async function refuseSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Refusing to write ${path}: it is a symbolic link.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** Builds every source, then writes the fonts and one merged stylesheet. Nothing is written if any source fails. */
export async function buildWebfonts(api: BuildApi, sources: string[], options: BuildOptions): Promise<BuildResult> {
  const deadline = Date.now() + options.timeoutMs;
  let temp: string | undefined;
  const tempDir = async (): Promise<string> =>
    (temp ??= await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'webfont-build-')));

  const files = new Map<string, { name: string; source: string; bytes: Uint8Array }>();
  const stylesheets: string[] = [];
  try {
    for (const source of sources) {
      const kit = await buildKit(api, source, options, deadline, tempDir);
      for (const [name, bytes] of kit.fonts) {
        const key = name.toLowerCase();
        const existing = files.get(key);
        if (existing) {
          throw new Error(
            `${basename(existing.source)} and ${basename(source)} both produce ${name}; ` +
              'give the fonts different family names or build them in separate steps.',
          );
        }
        files.set(key, { name, source, bytes });
      }
      stylesheets.push(kit.stylesheet);
    }
  } finally {
    if (temp !== undefined) {
      await rm(temp, { recursive: true, force: true });
    }
  }

  const targets = [...files.values()].map(({ name, bytes }) => ({ path: join(options.outputDir, name), bytes }));
  for (const path of [...targets.map((target) => target.path), options.cssFile]) {
    await refuseSymlink(path);
  }

  await mkdir(options.outputDir, { recursive: true });
  const written: string[] = [];
  for (const { path, bytes } of targets) {
    await writeFile(path, bytes);
    written.push(path);
  }
  await mkdir(dirname(options.cssFile), { recursive: true });
  await writeFile(options.cssFile, mergeStylesheets(stylesheets, options));
  return { files: written, cssPath: options.cssFile };
}
