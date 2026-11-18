import * as core from '@actions/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EfApi, EfApiError } from '../src/api';
import { buildWebfonts } from '../src/build';

vi.mock('@actions/core', () => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

const apiMock = { subsetRanges: vi.fn() };
vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  EfApi: vi.fn(function () {
    return apiMock;
  }),
}));
vi.mock('../src/fonts', () => ({ findFonts: vi.fn(async () => ['/ws/src/Inter.ttf']) }));
vi.mock('../src/build', () => ({ buildWebfonts: vi.fn() }));

import { handleFailure, NO_KEY_MESSAGE, PLAN_MESSAGE, run } from '../src/run';

const setInputs = (inputs: Record<string, string>): void => {
  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? '');
};

const runAction = async (): Promise<void> => {
  await run().catch(handleFailure);
};

const output = (name: string): unknown => vi.mocked(core.setOutput).mock.calls.find((call) => call[0] === name)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_WORKSPACE = '/ws';
  apiMock.subsetRanges.mockResolvedValue([
    { id: 'latin-basic', label: 'Basic Latin', category: 'character' },
    { id: 'greek', label: 'Greek', category: 'language' },
  ]);
  vi.mocked(buildWebfonts).mockResolvedValue({
    files: ['/ws/webfonts/Inter.woff2', '/ws/webfonts/Inter.woff'],
    cssPath: '/ws/webfonts/fonts.css',
  });
});

describe('run', () => {
  it('sets the files and css-path outputs relative to the workspace', async () => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf', formats: 'woff2, WOFF' });
    await runAction();

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(output('files')).toBe('webfonts/Inter.woff2\nwebfonts/Inter.woff');
    expect(output('css-path')).toBe('webfonts/fonts.css');
    expect(apiMock.subsetRanges).not.toHaveBeenCalled();
    expect(buildWebfonts).toHaveBeenCalledWith(apiMock, ['/ws/src/Inter.ttf'], {
      formats: ['woff2', 'woff'],
      subset: [],
      outputDir: '/ws/webfonts',
      cssFile: '/ws/webfonts/fonts.css',
      fontDisplay: 'swap',
      timeoutMs: 600000,
    });
  });

  it('masks the key before creating the API client', async () => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf' });
    await runAction();

    expect(vi.mocked(core.setSecret).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(EfApi).mock.invocationCallOrder[0]!,
    );
  });

  it('fails with the plan message, without the key, when the pre-flight answers 403', async () => {
    setInputs({ 'api-key': 'secret-key', sources: 'src/*.ttf', subset: 'latin-basic' });
    apiMock.subsetRanges.mockRejectedValue(new EfApiError('Everything Fonts API error (403): secret-key forbidden', { status: 403 }));
    await runAction();

    expect(core.setFailed).toHaveBeenCalledWith(PLAN_MESSAGE);
    expect(PLAN_MESSAGE).toBe('Web Font Build needs an API plan with conversion — see https://everythingfonts.com/api');
    expect(buildWebfonts).not.toHaveBeenCalled();
    expect(output('files')).toBe('');
  });

  it('fails with the plan message when the build answers 401', async () => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf' });
    vi.mocked(buildWebfonts).mockRejectedValue(new EfApiError('nope', { status: 401 }));
    await runAction();

    expect(core.setFailed).toHaveBeenCalledWith(PLAN_MESSAGE);
  });

  it('fails on an unknown preset, listing the valid ids', async () => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf', subset: 'latin-basic, klingon' });
    await runAction();

    const message = vi.mocked(core.setFailed).mock.calls[0]![0] as string;
    expect(message).toContain('klingon');
    expect(message).toContain('latin-basic, greek');
    expect(buildWebfonts).not.toHaveBeenCalled();
  });

  it('fails with a clear message and empty outputs when there is no key', async () => {
    setInputs({ sources: 'src/*.ttf' });
    await runAction();

    expect(core.setFailed).toHaveBeenCalledWith(NO_KEY_MESSAGE);
    expect(NO_KEY_MESSAGE).toBe(
      'Web Font Build needs an Everything Fonts API key with conversion — add it as a secret; secrets are not available to pull requests from forks.',
    );
    expect(output('files')).toBe('');
    expect(output('css-path')).toBe('');
    expect(EfApi).not.toHaveBeenCalled();
  });

  it.each([
    ['output-dir', '../elsewhere'],
    ['css-file', '/etc/fonts.css'],
  ])('refuses an %s outside the workspace', async (input, value) => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf', [input]: value });
    await runAction();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(`${input} must be inside the workspace`));
    expect(buildWebfonts).not.toHaveBeenCalled();
  });

  it('adds a retry hint to an outage', async () => {
    setInputs({ 'api-key': 'k', sources: 'src/*.ttf' });
    vi.mocked(buildWebfonts).mockRejectedValue(new EfApiError('Everything Fonts API error (503): down', { status: 503 }));
    await runAction();

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('try again in a few minutes'));
    expect(output('files')).toBe('');
  });
});
