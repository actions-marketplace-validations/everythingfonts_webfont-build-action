import * as core from '@actions/core';
import { dirname, relative, sep } from 'node:path';
import pkg from '../package.json';
import { EfApi, EfApiError } from './api';
import { buildWebfonts } from './build';
import { findFonts } from './fonts';
import {
  assertRealPathInsideWorkspace,
  parseApiUrl,
  parseFontDisplay,
  parseFormats,
  parseList,
  parseTimeoutMinutes,
  resolveInsideWorkspace,
} from './inputs';

export const NO_KEY_MESSAGE =
  'Web Font Build needs an Everything Fonts API key with conversion — add it as a secret; secrets are not available to pull requests from forks.';

export const PLAN_MESSAGE = 'Web Font Build needs an API plan with conversion — see https://everythingfonts.com/api';

export const KEY_REJECTED_MESSAGE =
  'Everything Fonts rejected the API key (HTTP 401). Check the api-key secret (EVERYTHINGFONTS_API_KEY).';

const RETRY_HINT = 'The Everything Fonts API is unavailable; try again in a few minutes.';

let outputsSet = false;

function setOutputs(files: string, cssPath: string): void {
  core.setOutput('files', files);
  core.setOutput('css-path', cssPath);
  outputsSet = true;
}

/** Called when run() throws: makes sure the outputs exist and the job fails. */
export function handleFailure(error: unknown): void {
  if (!outputsSet) {
    setOutputs('', '');
  }
  core.setFailed(error instanceof Error ? error.message : String(error));
}

/** Turns API errors into the messages a workflow author can act on. */
function explain(error: unknown): unknown {
  if (!(error instanceof EfApiError)) {
    return error;
  }
  if (error.status === 401) {
    return new Error(KEY_REJECTED_MESSAGE);
  }
  if (error.status === 403 && !error.isQuota()) {
    return new Error(PLAN_MESSAGE);
  }
  if (error.status === 0 || error.status >= 500) {
    return new Error(`${error.message} ${RETRY_HINT}`);
  }
  return error;
}

const workspacePath = (workspace: string, path: string): string => relative(workspace, path).split(sep).join('/');

export async function run(): Promise<void> {
  outputsSet = false;
  const apiKey = core.getInput('api-key');
  if (apiKey === '') {
    setOutputs('', '');
    core.setFailed(NO_KEY_MESSAGE);
    return;
  }
  core.setSecret(apiKey);
  const apiUrl = parseApiUrl(core.getInput('api-url'));

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const formats = parseFormats(core.getInput('formats'));
  const subset = parseList(core.getInput('subset'));
  const fontDisplay = parseFontDisplay(core.getInput('font-display'));
  const timeoutMs = parseTimeoutMinutes(core.getInput('timeout-minutes')) * 60000;
  const outputDirInput = core.getInput('output-dir') || 'webfonts/';
  const cssFileInput = core.getInput('css-file') || 'webfonts/fonts.css';
  const outputDir = resolveInsideWorkspace(workspace, outputDirInput, 'output-dir');
  const cssFile = resolveInsideWorkspace(workspace, cssFileInput, 'css-file');
  await assertRealPathInsideWorkspace(workspace, outputDir, outputDirInput, 'output-dir');
  await assertRealPathInsideWorkspace(workspace, dirname(cssFile), cssFileInput, 'css-file');

  const patterns = core.getInput('sources', { required: true });
  const sources = await findFonts({ patterns });
  if (sources.length === 0) {
    throw new Error(`No font files match sources: ${patterns}`);
  }

  const api = new EfApi({
    baseUrl: apiUrl,
    apiKey,
    client: `github-action/webfont-build@${pkg.version}`,
    repo: process.env.GITHUB_REPOSITORY,
  });

  try {
    if (subset.length > 0) {
      const validIds = (await api.subsetRanges()).map((range) => range.id);
      const unknown = subset.filter((id) => !validIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(`Unknown subset preset ${unknown.join(', ')}. Valid ids: ${validIds.join(', ')}`);
      }
    }
    const result = await buildWebfonts(api, sources, { formats, subset, outputDir, cssFile, fontDisplay, timeoutMs });
    const files = result.files.map((file) => workspacePath(workspace, file));
    setOutputs(files.join('\n'), workspacePath(workspace, result.cssPath));
    core.info(`Wrote ${files.length} font file(s) and ${workspacePath(workspace, result.cssPath)}`);
  } catch (error) {
    throw explain(error);
  }
}
