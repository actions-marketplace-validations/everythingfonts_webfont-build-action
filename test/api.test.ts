import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EfApi, EfApiError, MAX_DOWNLOAD_BYTES, repoHash } from '../src/api';

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

let fetchMock: ReturnType<typeof vi.fn>;
let sleep: ReturnType<typeof vi.fn>;

const makeApi = (repo: string | undefined = 'owner/repo', extra: Partial<ConstructorParameters<typeof EfApi>[0]> = {}): EfApi =>
  new EfApi({
    baseUrl: 'https://font.rest/api/v1',
    apiKey: 'secret-key-123',
    client: 'github-action/webfont-build@1.0.0',
    repo,
    sleep: sleep as unknown as (ms: number) => Promise<void>,
    ...extra,
  });

beforeEach(() => {
  fetchMock = vi.fn();
  sleep = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('headers', () => {
  it('sends the four headers, with the repo as a sha256 of owner/repo', async () => {
    fetchMock.mockResolvedValue(json({ success: { total: 1 }, contents: { id: 'i1', status: 'pending' } }));

    await makeApi().inspection('i1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://font.rest/api/v1/inspections/i1');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key-123');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-EverythingFonts-Client')).toBe('github-action/webfont-build@1.0.0');
    const expected = createHash('sha256').update('owner/repo').digest('hex');
    expect(headers.get('X-EverythingFonts-Repo')).toBe(expected);
    expect(repoHash('owner/repo')).toBe(expected);
  });
});

describe('uploadFont', () => {
  it('posts multipart with field font and returns contents.id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfb-'));
    const file = join(dir, 'a.ttf');
    writeFileSync(file, Buffer.from([0, 1, 0, 0]));
    fetchMock.mockResolvedValue(json({ success: { total: 1 }, contents: { id: 'font-9' } }));

    const id = await makeApi().uploadFont(file);

    expect(id).toBe('font-9');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://font.rest/api/v1/font');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const part = (init.body as FormData).get('font') as File;
    expect(part.name).toBe('a.ttf');
    expect(part.size).toBe(4);
  });
});

describe('inspect', () => {
  it('returns id, status and the allowance from headers', async () => {
    fetchMock.mockResolvedValue(
      json(
        { success: { total: 1 }, contents: { id: 'i1', status: 'pending' } },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Allowance-Limit': '100',
            'X-Allowance-Remaining': '99',
            'X-Allowance-Reset': '1796083200',
          },
        },
      ),
    );

    const result = await makeApi().inspect('font-9');

    expect(fetchMock.mock.calls[0][0]).toBe('https://font.rest/api/v1/font/font-9/inspect');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(result).toEqual({
      id: 'i1',
      status: 'pending',
      allowance: { limit: 100, used: 1, remaining: 99, resetsAt: '2026-12-01T00:00:00.000Z' },
    });
  });
});

describe('429 handling', () => {
  it('retries a plain 429 after Retry-After and succeeds on the third try', async () => {
    const throttled = () =>
      json({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'Retry-After': '2' } });
    fetchMock
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(json({ success: { total: 1 }, contents: { id: 'i1', status: 'pending' } }));

    const result = await makeApi().inspection('i1');

    expect(result.id).toBe('i1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it('gives up after five retries of a plain 429', async () => {
    fetchMock.mockImplementation(async () => json({ message: 'Too Many Attempts.' }, { status: 429 }));

    await expect(makeApi().inspection('i1')).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledWith(6000);
  });

  it('throws a quota error for allowance_exhausted without retrying', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          message: 'used up',
          error: { code: 429, type: 'allowance_exhausted', message: 'used up' },
          allowance: { limit: 100, used: 100, remaining: 0, resets_at: '2026-12-01T00:00:00Z', plan: 'free' },
        },
        { status: 429 },
      ),
    );

    const error = await makeApi().inspect('font-9').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EfApiError);
    const apiError = error as EfApiError;
    expect(apiError.isQuota()).toBe(true);
    expect(apiError.status).toBe(429);
    expect(apiError.type).toBe('allowance_exhausted');
    expect(apiError.allowance).toEqual({ limit: 100, used: 100, remaining: 0, resetsAt: '2026-12-01T00:00:00Z' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('treats upload_limit as a quota error', async () => {
    fetchMock.mockResolvedValue(
      json({ message: 'x', error: { code: 429, type: 'upload_limit', message: 'x' } }, { status: 429 }),
    );
    const dir = mkdtempSync(join(tmpdir(), 'wfb-'));
    const file = join(dir, 'a.ttf');
    writeFileSync(file, 'x');

    const error = (await makeApi().uploadFont(file).catch((e: unknown) => e)) as EfApiError;

    expect(error.isQuota()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('waitForInspection', () => {
  const state = (status: string, extra: object = {}) =>
    json({ success: { total: 1 }, contents: { id: 'i1', status, ...extra } });

  it('polls pending, processing, succeeded with backoff and returns the summary', async () => {
    fetchMock
      .mockResolvedValueOnce(state('pending'))
      .mockResolvedValueOnce(state('processing'))
      .mockResolvedValueOnce(state('succeeded', { score: 88, band: 'healthy', report_url: 'https://x/r' }));

    const result = await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(result).toMatchObject({ id: 'i1', status: 'succeeded', score: 88, band: 'healthy' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it('caps the backoff at 15 seconds', async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(state('pending'));
    }
    fetchMock.mockResolvedValueOnce(state('succeeded'));

    await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('returns a failed inspection as is', async () => {
    fetchMock.mockResolvedValueOnce(state('failed'));

    const result = await makeApi().waitForInspection('i1', { timeoutMs: 600000 });

    expect(result.status).toBe('failed');
  });

  it('throws when the wall-clock deadline passes, clamping the last sleep', async () => {
    let clock = 0;
    sleep.mockImplementation(async (ms: number) => {
      clock += ms;
    });
    fetchMock.mockImplementation(async () => {
      clock += 1000;
      return state('pending');
    });

    await expect(
      makeApi('owner/repo', { now: () => clock }).waitForInspection('i1', { timeoutMs: 10000 }),
    ).rejects.toThrow(/timed out/i);
    expect(Math.max(...sleep.mock.calls.map((c) => c[0]))).toBeLessThanOrEqual(10000);
    expect(clock).toBeLessThanOrEqual(10000 + 1000);
  });

  it('does not sleep through a Retry-After that passes the deadline', async () => {
    let clock = 0;
    fetchMock.mockResolvedValue(json({ message: 'Too Many' }, { status: 429, headers: { 'Retry-After': '30' } }));

    await expect(
      makeApi('owner/repo', { now: () => clock }).waitForInspection('i1', { timeoutMs: 10000 }),
    ).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('waits and failures', () => {
  it('parses an HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    fetchMock
      .mockResolvedValueOnce(
        json({ message: 'x' }, { status: 429, headers: { 'Retry-After': 'Wed, 18 Nov 2026 10:00:05 GMT' } }),
      )
      .mockResolvedValueOnce(json({ success: { total: 1 }, contents: { id: 'i1', status: 'pending' } }));

    await makeApi('owner/repo', { now: () => now }).inspection('i1');

    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('throws instead of sleeping when Retry-After is over 60 seconds', async () => {
    fetchMock.mockResolvedValue(json({ message: 'x' }, { status: 429, headers: { 'Retry-After': '61' } }));

    await expect(makeApi().inspection('i1')).rejects.toMatchObject({ status: 429 });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure to status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed secret-key-123'));

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(error).toBeInstanceOf(EfApiError);
    expect(error.status).toBe(0);
    expect(error.message).not.toContain('secret-key-123');
  });

  it('passes an abort signal and maps a timeout to status 0', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    const error = (await makeApi('owner/repo', { requestTimeoutMs: 5000 }).inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/did not answer within 5 seconds/);
  });

  it('gives uploadFont its own longer timeout; other calls keep 30 seconds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ef-'));
    const file = join(dir, 'A.ttf');
    writeFileSync(file, 'x');
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    const upload = (await makeApi().uploadFont(file).catch((e: unknown) => e)) as EfApiError;
    const custom = (await makeApi('owner/repo', { uploadTimeoutMs: 90000 }).uploadFont(file).catch((e: unknown) => e)) as EfApiError;
    const other = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(upload.message).toMatch(/within 300 seconds/);
    expect(custom.message).toMatch(/within 90 seconds/);
    expect(other.message).toMatch(/within 30 seconds/);
  });

  it('does not retry a 5xx', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 500, message: 'boom' } }, { status: 500 }));

    await expect(makeApi().inspection('i1')).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scrubs the api key from the stored body', async () => {
    fetchMock.mockResolvedValue(json({ message: 'bad token secret-key-123' }, { status: 401 }));

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(JSON.stringify(error.body)).not.toContain('secret-key-123');
  });
});

describe('errors', () => {
  it('throws EfApiError with status on a 5xx', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 503, message: 'down' } }, { status: 503 }));

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(error).toBeInstanceOf(EfApiError);
    expect(error.status).toBe(503);
    expect(error.isQuota()).toBe(false);
    expect(error.message).toContain('down');
  });

  it('never puts the api key in an error message', async () => {
    fetchMock.mockResolvedValue(
      json({ message: 'bad token secret-key-123' }, { status: 401 }),
    );

    const error = (await makeApi().inspection('i1').catch((e: unknown) => e)) as EfApiError;

    expect(error.message).not.toContain('secret-key-123');
  });
});

describe('fontfaceKit', () => {
  it('requests the kit with targetformats=woff2,woff and returns the kit id', async () => {
    fetchMock.mockResolvedValue(json({ success: { total: 1 }, contents: { id: 'kit-1', notice: 'n' } }));

    const id = await makeApi().fontfaceKit('font-9', ['woff2', 'woff']);

    expect(id).toBe('kit-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://font.rest/api/v1/font/font-9/convert/fontface?targetformats=woff2,woff');
    expect(init.method).toBe('GET');
  });
});

describe('kitStatus and waitForKit', () => {
  const kit = (status: string, downloadurl: string | null = null) =>
    json({ success: { total: 1 }, contents: { schedule: { status }, downloadurl } });

  it('reads the status and download url', async () => {
    fetchMock.mockResolvedValue(kit('SUCCESS', 'https://x/z.zip'));

    const result = await makeApi().kitStatus('kit-1');

    expect(fetchMock.mock.calls[0][0]).toBe('https://font.rest/api/v1/font/convert/schedule?id=kit-1');
    expect(result).toEqual({ status: 'SUCCESS', downloadurl: 'https://x/z.zip' });
  });

  it('polls NEW, PROCESSING, SUCCESS with backoff and returns the url', async () => {
    fetchMock
      .mockResolvedValueOnce(kit('NEW'))
      .mockResolvedValueOnce(kit('PROCESSING'))
      .mockResolvedValueOnce(kit('SUCCESS', 'https://x/z.zip'));

    const url = await makeApi().waitForKit('kit-1', { timeoutMs: 600000 });

    expect(url).toBe('https://x/z.zip');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  it.each(['FAILED', 'EXPIRED'])('throws a clear error on %s, without the key', async (status) => {
    fetchMock.mockResolvedValue(kit(status));

    const error = (await makeApi().waitForKit('kit-1', { timeoutMs: 600000 }).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(status);
    expect(error.message).not.toContain('secret-key-123');
  });

  it('throws when the deadline passes', async () => {
    let clock = 0;
    sleep.mockImplementation(async (ms: number) => {
      clock += ms;
    });
    fetchMock.mockImplementation(async () => {
      clock += 1000;
      return kit('PROCESSING');
    });

    await expect(
      makeApi('owner/repo', { now: () => clock }).waitForKit('kit-1', { timeoutMs: 10000 }),
    ).rejects.toThrow(/timed out.*last status: PROCESSING/i);
  });
});

describe('subset', () => {
  it('returns raw bytes for an octet-stream response', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'Content-Type': 'application/octet-stream' } }),
    );

    const bytes = await makeApi().subset('font-9', ['latin', 'latin-ext'], 'woff2');

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://font.rest/api/v1/font/font-9/subset?preset=latin,latin-ext&binaryresult=true&targetformat=woff2',
    );
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Accept')).toBe(
      'application/octet-stream, application/json',
    );
  });

  it('omits targetformat when none is given', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1])));

    await makeApi().subset('font-9', ['latin']);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://font.rest/api/v1/font/font-9/subset?preset=latin&binaryresult=true',
    );
  });

  it('reads a JSON error body on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 403, message: 'No conversion ability' } }, { status: 403 }));

    const error = (await makeApi().subset('font-9', ['latin']).catch((e: unknown) => e)) as EfApiError;

    expect(error).toBeInstanceOf(EfApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('No conversion ability');
  });
});

describe('download', () => {
  it('sends no Authorization or X-EverythingFonts headers and uses the 300 second timeout', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([9, 8, 7])));

    const bytes = await makeApi().download('https://files.example/kit.zip?sig=abc');

    expect(Array.from(bytes)).toEqual([9, 8, 7]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://files.example/kit.zip?sig=abc');
    const names = [...new Headers(init.headers).keys()];
    expect(names).not.toContain('authorization');
    expect(names.filter((n) => n.startsWith('x-everythingfonts'))).toEqual([]);
  });

  it('maps a timeout to the download copy', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    const error = (await makeApi().download('https://files.example/kit.zip').catch((e: unknown) => e)) as EfApiError;

    expect(error.message).toBe('Could not download the built files \u2014 try again.');
  });

  it('throws EfApiError on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('expired', { status: 403 }));

    const error = (await makeApi().download('https://files.example/kit.zip').catch((e: unknown) => e)) as EfApiError;

    expect(error.status).toBe(403);
    expect(error.message).toBe(
      'Downloading the built files failed (HTTP 403). The link may have expired; re-run the job.',
    );
  });

  it('scrubs the signed url and query from the message and body of a failed download', async () => {
    const url = 'https://x/kit.zip?expires=1&signature=abc';
    fetchMock.mockResolvedValue(new Response(`bad ${url} signature=abc expires=1&signature=abc`, { status: 403 }));

    const error = (await makeApi().download(url).catch((e: unknown) => e)) as EfApiError;

    const dump = `${error.message} ${JSON.stringify(error.body)}`;
    expect(dump).not.toContain('abc');
    expect(dump).not.toContain('expires=1');
  });

  it('scrubs the body before cutting it to 200 characters, so no part of a signature at the cut survives', async () => {
    const signature = 'sig0123456789abcdefSECRET';
    const url = `https://x/kit.zip?signature=${signature}`;
    const prefix = 'p'.repeat(200 - 'signature='.length - 8);
    fetchMock.mockResolvedValue(new Response(`${prefix}signature=${signature} trailing`, { status: 403 }));

    const error = (await makeApi().download(url).catch((e: unknown) => e)) as EfApiError;

    expect(typeof error.body).toBe('string');
    expect((error.body as string).length).toBeLessThanOrEqual(200);
    expect(error.body as string).not.toContain('sig0123');
  });

  it('stops a download whose Content-Length is over the cap without reading the body', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(10));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { headers: { 'Content-Length': '101' } }));

    const error = (await makeApi('owner/repo', { maxDownloadBytes: 100 })
      .download('https://x/kit.zip?signature=abc')
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toBe('The built files are larger than 250 MB; the download was stopped.');
    expect(error).not.toBeInstanceOf(EfApiError);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('stops a download that grows past the cap while it is read', async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(40));
      },
    });
    fetchMock.mockResolvedValue(new Response(body));

    const error = (await makeApi('owner/repo', { maxDownloadBytes: 100 })
      .download('https://x/kit.zip')
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toBe('The built files are larger than 250 MB; the download was stopped.');
    expect(chunks).toBeLessThan(10);
  });

  it('accepts a download exactly at the cap and defaults the cap to 250 MB', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(100), { headers: { 'Content-Length': '100' } }));

    const bytes = await makeApi('owner/repo', { maxDownloadBytes: 100 }).download('https://x/kit.zip');

    expect(bytes.length).toBe(100);
    expect(MAX_DOWNLOAD_BYTES).toBe(250 * 1024 * 1024);
  });

  it('uses its own copy for a failed network download and scrubs the url', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed https://x/kit.zip?signature=abc'));

    const error = (await makeApi().download('https://x/kit.zip?signature=abc').catch((e: unknown) => e)) as EfApiError;

    expect(error.status).toBe(0);
    expect(error.message).toBe('Could not download the built files \u2014 try again.');
  });
});

describe('subsetRanges', () => {
  it('returns the preset ids, labels and categories', async () => {
    fetchMock.mockResolvedValue(
      json({ success: { total: 1 }, contents: { ranges: [{ id: 'latin-basic', label: 'Basic Latin', category: 'character', value: 'U+0000-007F' }] } }),
    );

    const ranges = await makeApi().subsetRanges();

    expect(fetchMock.mock.calls[0][0]).toBe('https://font.rest/api/v1/font/subset/ranges');
    expect(ranges).toEqual([{ id: 'latin-basic', label: 'Basic Latin', category: 'character' }]);
  });
});
