import * as glob from '@actions/glob';

/** Splits glob patterns on newlines and on commas that are not inside braces. */
export function splitPatterns(input: string): string[] {
  const patterns: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    let depth = 0;
    let current = '';
    for (const char of line) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
      }
      if (char === ',' && depth === 0) {
        patterns.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    patterns.push(current);
  }
  return patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern !== '');
}

/** Expands `{a,b}` groups, because @actions/glob turns brace expansion off. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    return [pattern];
  }
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (char === ',' && depth === 1) {
      commas.push(i);
    }
  }
  if (close === -1) {
    return [pattern];
  }
  if (commas.length === 0) {
    const literal = pattern.slice(0, close + 1);
    return expandBraces(pattern.slice(close + 1)).map((rest) => literal + rest);
  }
  const bounds = [open, ...commas, close];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const results: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    for (const option of expandBraces(pattern.slice(bounds[i] + 1, bounds[i + 1]))) {
      results.push(...expandBraces(head + option + tail));
    }
  }
  return results;
}

/** Absolute paths of the files matching `patterns`, sorted and de-duplicated. */
export async function findFonts(options: { patterns: string }): Promise<string[]> {
  const patterns = splitPatterns(options.patterns).flatMap(expandBraces);
  if (patterns.length === 0) {
    return [];
  }
  const globber = await glob.create(patterns.join('\n'), { followSymbolicLinks: false, matchDirectories: false });
  return [...new Set(await globber.glob())].sort();
}
