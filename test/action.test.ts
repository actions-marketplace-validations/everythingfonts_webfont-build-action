import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');

/** Parses YAML with PyYAML (preinstalled on GitHub's ubuntu runners), so no YAML package is needed. */
const loadYaml = (file: string): Record<string, unknown> =>
  JSON.parse(
    execFileSync('python3', ['-c', 'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', file], {
      encoding: 'utf8',
    }),
  );

describe('action.yml', () => {
  it('parses and declares the documented inputs and outputs', () => {
    const action = loadYaml(join(root, 'action.yml'));

    expect(Object.keys(action.inputs as object)).toEqual([
      'api-key',
      'sources',
      'formats',
      'subset',
      'output-dir',
      'css-file',
      'font-display',
      'api-url',
      'timeout-minutes',
    ]);
    expect(Object.keys(action.outputs as object)).toEqual(['files', 'css-path']);
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/index.js' });
  });

  it.each(readdirSync(join(root, '.github', 'workflows')))('workflow %s parses', (file) => {
    expect(loadYaml(join(root, '.github', 'workflows', file))).toHaveProperty('jobs');
  });
});
