import { describe, expect, it } from 'vitest';
import { extractFontFaces, fontUrl, mergeStylesheets, rewriteFontFace } from '../src/css';

const kit = (family: string, extra = ''): string =>
  `@font-face {\n  font-family: '${family}';\n  src: url('${family}.woff2') format('woff2'),\n       url(${family}.woff) format('woff');\n  font-weight: normal;${extra}\n}\n`;

describe('fontUrl', () => {
  it('is relative to the stylesheet next to the fonts folder', () => {
    expect(fontUrl('Inter.woff2', 'webfonts/fonts', 'webfonts/fonts.css')).toBe('fonts/Inter.woff2');
  });

  it('climbs out of a stylesheet folder elsewhere, with forward slashes', () => {
    expect(fontUrl('Inter.woff2', 'webfonts/fonts', 'css/site.css')).toBe('../webfonts/fonts/Inter.woff2');
  });
});

describe('rewriteFontFace', () => {
  const opts = { outputDir: 'webfonts/fonts', cssFile: 'webfonts/fonts.css', fontDisplay: 'swap' };

  it('rewrites url(Inter.woff2) to the path relative to the css file', () => {
    const block = rewriteFontFace(`@font-face { font-family: Inter; src: url(Inter.woff2) format('woff2'); }`, opts);

    expect(block).toContain('url(fonts/Inter.woff2)');
  });

  it('keeps quotes and an #iefix suffix, and leaves data: and absolute urls alone', () => {
    const block = rewriteFontFace(
      `@font-face { src: url("Inter.eot?#iefix") format('embedded-opentype'), url(data:font/woff2;base64,AAAA), url(https://cdn.example/x.woff); }`,
      opts,
    );

    expect(block).toContain('url("fonts/Inter.eot?#iefix")');
    expect(block).toContain('url(data:font/woff2;base64,AAAA)');
    expect(block).toContain('url(https://cdn.example/x.woff)');
  });

  it('quotes a rewritten url that contains a space', () => {
    const block = rewriteFontFace(`@font-face { src: url(Open Sans.woff2); }`, opts);

    expect(block).toContain('url("fonts/Open Sans.woff2")');
  });

  it('replaces an existing font-display', () => {
    const block = rewriteFontFace(kit('Inter', '\n  font-display: block;'), { ...opts, fontDisplay: 'optional' });

    expect(block).toContain('font-display: optional;');
    expect(block).not.toContain('block');
  });

  it('inserts font-display when the block has none', () => {
    const block = rewriteFontFace(kit('Inter'), opts);

    expect(block.match(/font-display/g)).toHaveLength(1);
    expect(block).toMatch(/font-display: swap;\s*\}$/);
  });
});

describe('mergeStylesheets', () => {
  it('merges the @font-face blocks of two kits and drops everything else', () => {
    const first = `/* generated */\n${kit('Inter')}\nbody { font-family: Inter; }\n`;
    const second = kit('Lora');

    const css = mergeStylesheets([first, second], { outputDir: 'webfonts', cssFile: 'webfonts/fonts.css', fontDisplay: 'swap' });

    expect(extractFontFaces(css)).toHaveLength(2);
    expect(css).toContain("url('Inter.woff2')");
    expect(css).toContain('url(Lora.woff)');
    expect(css).not.toContain('body {');
    expect(css.match(/font-display: swap;/g)).toHaveLength(2);
  });
});
