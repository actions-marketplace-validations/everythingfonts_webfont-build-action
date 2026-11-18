import * as core from '@actions/core';
import pkg from '../package.json';
import { EfApi } from './api';

async function run(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true });
  core.setSecret(apiKey);
  const api = new EfApi({
    baseUrl: core.getInput('api-url') || 'https://font.rest/api/v1',
    apiKey,
    client: `github-action/webfont-build@${pkg.version}`,
    repo: process.env.GITHUB_REPOSITORY,
  });
  core.getInput('sources', { required: true });
  void api;
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
