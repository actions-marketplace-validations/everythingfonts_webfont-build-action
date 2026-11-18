import { describe, expect, it } from 'vitest';
import { parseApiUrl } from '../src/inputs';

describe('parseApiUrl', () => {
  it('falls back to the default when empty and trims the value', () => {
    expect(parseApiUrl('')).toBe('https://font.rest/api/v1');
    expect(parseApiUrl('   ')).toBe('https://font.rest/api/v1');
    expect(parseApiUrl(' https://everythingfonts.com/api/v1 ')).toBe('https://everythingfonts.com/api/v1');
  });

  it('allows http only for localhost and 127.0.0.1', () => {
    expect(parseApiUrl('http://localhost:8000/api/v1')).toBe('http://localhost:8000/api/v1');
    expect(parseApiUrl('http://127.0.0.1/api/v1')).toBe('http://127.0.0.1/api/v1');
    for (const bad of ['http://example.com/api/v1', 'http://localhost.example.com', 'ftp://font.rest', 'font.rest/api/v1']) {
      expect(() => parseApiUrl(bad)).toThrow('Input api-url must be an https URL');
    }
  });
});
