import { strFromU8, strToU8, zipSync } from 'fflate';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { EfApiError } from '../src/api';
import { buildWebfonts, type BuildApi } from '../src/build';

vi.mock('@actions/core', () => ({ info: vi.fn(), warning: vi.fn(), setSecret: vi.fn() }));

const stylesheet = (family: string): string =>
  `@font-face {\n  font-family: '${family}';\n  src: url('${family}.woff2') format('woff2');\n}\n`;

const kitZip = (family: string, extra: Record<string, Uint8Array> = {}): Uint8Array =>
  zipSync({
    [`${family}.woff2`]: new Uint8Array([1, 2, 3]),
    'stylesheet.css': strToU8(stylesheet(family)),
    'demo.html': strToU8('<html></html>'),
    ...extra,
  });

/** Edits the central-directory header of the entry `name` in place. */
const patchCentralEntry = (zip: Uint8Array, name: string, patch: (view: DataView, offset: number) => void): Uint8Array => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let offset = 0; offset + 46 <= zip.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      const nameLength = view.getUint16(offset + 28, true);
      if (strFromU8(zip.subarray(offset + 46, offset + 46 + nameLength)) === name) {
        patch(view, offset);
      }
    }
  }
  return zip;
};

/** Rewrites the uncompressed size declared for `name`, as a zip bomb would. */
const declareSize = (zip: Uint8Array, name: string, size: number): Uint8Array =>
  patchCentralEntry(zip, name, (view, offset) => view.setUint32(offset + 24, size, true));

const MB = 1024 * 1024;

let workspace: string;
let api: { [K in keyof BuildApi]: ReturnType<typeof vi.fn> };

const options = () => ({
  formats: ['woff2'],
  subset: [] as string[],
  outputDir: join(workspace, 'webfonts', 'fonts'),
  cssFile: join(workspace, 'webfonts', 'fonts.css'),
  fontDisplay: 'swap',
  timeoutMs: 60000,
});

const source = (name: string): string => {
  const path = join(workspace, name);
  writeFileSync(path, Buffer.from([0, 1, 0, 0]));
  return path;
};

beforeEach(() => {
  vi.clearAllMocks();
  workspace = mkdtempSync(join(tmpdir(), 'wfb-build-'));
  api = {
    uploadFont: vi.fn(async () => 'font-1'),
    subset: vi.fn(async () => new Uint8Array([7, 7, 7])),
    fontfaceKit: vi.fn(async () => 'kit-1'),
    waitForKit: vi.fn(async () => 'https://files.example/kit.zip?signature=a'),
    kitStatus: vi.fn(),
    download: vi.fn(async () => kitZip('Inter')),
  };
});

const build = (sources: string[], overrides: Partial<ReturnType<typeof options>> = {}) =>
  buildWebfonts(api as unknown as BuildApi, sources, { ...options(), ...overrides });

describe('buildWebfonts', () => {
  it('writes the font files and the merged stylesheet, and drops demo.html', async () => {
    const result = await build([source('Inter.ttf')]);

    const fontPath = join(workspace, 'webfonts', 'fonts', 'Inter.woff2');
    expect(result).toEqual({ files: [fontPath], cssPath: join(workspace, 'webfonts', 'fonts.css') });
    expect(Array.from(readFileSync(fontPath))).toEqual([1, 2, 3]);
    expect(readdirSync(join(workspace, 'webfonts', 'fonts'))).toEqual(['Inter.woff2']);
    const css = readFileSync(result.cssPath, 'utf8');
    expect(css).toContain("url('fonts/Inter.woff2')");
    expect(css).toContain('font-display: swap;');
    expect(api.uploadFont).toHaveBeenCalledTimes(1);
    expect(api.subset).not.toHaveBeenCalled();
    expect(api.fontfaceKit).toHaveBeenCalledWith('font-1', ['woff2']);
  });

  it('uses only the base name of zip entries and skips formats that were not requested', async () => {
    api.download.mockResolvedValue(
      kitZip('Inter', {
        '../../escape.woff2': new Uint8Array([9]),
        'nested/dir/Inter.ttf': new Uint8Array([9]),
        'run.sh': new Uint8Array([9]),
      }),
    );

    await build([source('Inter.ttf')]);

    expect(existsSync(join(workspace, 'escape.woff2'))).toBe(false);
    expect(readdirSync(join(workspace, 'webfonts', 'fonts')).sort()).toEqual(['Inter.woff2', 'escape.woff2']);
  });

  it('subsets first and uploads the subset bytes, building the kit from the subset font', async () => {
    api.uploadFont.mockResolvedValueOnce('font-1').mockImplementationOnce(async (path: string) => {
      expect(Array.from(readFileSync(path))).toEqual([7, 7, 7]);
      return 'subset-1';
    });

    await build([source('Inter.ttf')], { subset: ['latin-basic', 'greek'] });

    expect(api.subset).toHaveBeenCalledWith('font-1', ['latin-basic', 'greek']);
    expect(api.uploadFont).toHaveBeenCalledTimes(2);
    expect(api.fontfaceKit).toHaveBeenCalledWith('subset-1', ['woff2']);
  });

  it('masks the signed download link before downloading it', async () => {
    await build([source('Inter.ttf')]);

    expect(core.setSecret).toHaveBeenCalledWith('https://files.example/kit.zip?signature=a');
    expect(vi.mocked(core.setSecret).mock.invocationCallOrder[0]).toBeLessThan(api.download.mock.invocationCallOrder[0]!);
  });

  it('refreshes an expired download link once through the kit status', async () => {
    api.download
      .mockRejectedValueOnce(new EfApiError('expired', { status: 410 }))
      .mockResolvedValueOnce(kitZip('Inter'));
    api.kitStatus.mockResolvedValue({ status: 'SUCCESS', downloadurl: 'https://files.example/fresh.zip' });

    const result = await build([source('Inter.ttf')]);

    expect(api.kitStatus).toHaveBeenCalledTimes(1);
    expect(api.download).toHaveBeenLastCalledWith('https://files.example/fresh.zip');
    expect(core.setSecret).toHaveBeenCalledWith('https://files.example/fresh.zip');
    expect(result.files).toHaveLength(1);
  });

  it('fails without an API error type when the refreshed link fails too', async () => {
    api.download.mockRejectedValue(new EfApiError('Downloading the built files failed (HTTP 403).', { status: 403 }));
    api.kitStatus.mockResolvedValue({ status: 'SUCCESS', downloadurl: 'https://files.example/fresh.zip' });

    const error = await build([source('Inter.ttf')]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EfApiError);
    expect(api.download).toHaveBeenCalledTimes(2);
  });

  it('fails on two sources that produce the same file name, writing nothing', async () => {
    const error = (await build([source('Inter.ttf'), source('Inter-copy.otf')]).catch((e: unknown) => e)) as Error;

    expect(error.message).toBe(
      'Inter.ttf and Inter-copy.otf both produce Inter.woff2 \u2014 rename one of the source files (e.g. Inter.ttf vs Inter.otf) or build them in separate steps with different output-dir.',
    );
    expect(existsSync(join(workspace, 'webfonts'))).toBe(false);
  });

  it.each([
    ['a font file', (): string => join(workspace, 'webfonts', 'fonts', 'Inter.woff2'), ['fonts']],
    ['the stylesheet', (): string => join(workspace, 'webfonts', 'fonts.css'), ['fonts', 'fonts.css']],
  ])('refuses to write through %s that is an existing symlink, writing nothing', async (_name, target, entries) => {
    const outside = mkdtempSync(join(tmpdir(), 'wfb-outside-'));
    writeFileSync(join(outside, 'victim'), 'keep');
    mkdirSync(join(workspace, 'webfonts', 'fonts'), { recursive: true });
    symlinkSync(join(outside, 'victim'), target());

    const error = (await build([source('Inter.ttf')]).catch((e: unknown) => e)) as Error;

    expect(error.message).toBe(`Refusing to write ${target()}: it is a symbolic link.`);
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep');
    expect(readdirSync(join(workspace, 'webfonts')).sort()).toEqual(entries);
    expect(readdirSync(join(workspace, 'webfonts', 'fonts'))).toEqual(entries.length === 1 ? ['Inter.woff2'] : []);
  });

  it('rejects a requested entry that declares more than 50 MB, writing nothing', async () => {
    api.download.mockResolvedValue(declareSize(kitZip('Inter'), 'Inter.woff2', 50 * MB + 1));

    const error = (await build([source('Inter.ttf')]).catch((e: unknown) => e)) as Error;

    expect(error.message).toBe("Inter.ttf: the built kit's Inter.woff2 is larger than 50 MB.");
    expect(existsSync(join(workspace, 'webfonts'))).toBe(false);
  });

  it('rejects a kit whose requested entries add up to more than 200 MB', async () => {
    const formats = ['woff2', 'woff', 'ttf', 'eot', 'svg'];
    let zip = kitZip('Inter', Object.fromEntries(formats.slice(1).map((format) => [`Inter.${format}`, new Uint8Array([1])])));
    for (const format of formats) {
      zip = declareSize(zip, `Inter.${format}`, 45 * MB);
    }
    api.download.mockResolvedValue(zip);

    const error = (await build([source('Inter.ttf')], { formats }).catch((e: unknown) => e)) as Error;

    expect(error.message).toBe("Inter.ttf: the built kit's requested files add up to more than 200 MB.");
  });

  it('never inflates entries that were not requested, whatever they declare', async () => {
    const zip = declareSize(kitZip('Inter', { 'Inter.woff': new Uint8Array([5]) }), 'demo.html', 4000 * MB);
    patchCentralEntry(zip, 'demo.html', (view, offset) => view.setUint16(offset + 10, 99, true));
    api.download.mockResolvedValue(zip);

    const result = await build([source('Inter.ttf')]);

    expect(result.files).toEqual([join(workspace, 'webfonts', 'fonts', 'Inter.woff2')]);
  });
});
