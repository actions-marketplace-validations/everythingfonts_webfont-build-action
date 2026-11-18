import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface Allowance {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}

export interface Finding {
  code: string;
  severity: string;
  category: string;
  title: string;
}

export interface Inspection {
  id: string;
  status: 'pending' | 'processing' | 'failed' | 'succeeded' | string;
  score?: number;
  band?: 'healthy' | 'needs-attention' | 'unhealthy' | string;
  counts?: { error: number; warning: number; info: number; pass: number };
  findings?: Finding[];
  report_url?: string;
}

export interface SubsetRange {
  id: string;
  label: string;
  category: string;
}

export interface EfApiOptions {
  baseUrl: string;
  apiKey: string;
  client: string;
  repo?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  maxDownloadBytes?: number;
}

const QUOTA_TYPES = ['allowance_exhausted', 'upload_limit'];
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_AFTER_SECONDS = 6;
const POLL_START_MS = 2000;
const POLL_CAP_MS = 15000;
const MAX_WAIT_MS = 60000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 300000;

/** The largest built-kit zip `download` reads (250 MB). */
export const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TOO_LARGE = 'The built files are larger than 250 MB; the download was stopped.';

/** sha256 hex of `owner/repo`, so the plain repository name is never sent. */
export function repoHash(repository: string): string {
  return createHash('sha256').update(repository).digest('hex');
}

export class EfApiError extends Error {
  status: number;
  type?: string;
  allowance?: Allowance;
  body: unknown;

  constructor(message: string, init: { status: number; type?: string; allowance?: Allowance; body?: unknown }) {
    super(message);
    this.name = 'EfApiError';
    this.status = init.status;
    this.type = init.type;
    this.allowance = init.allowance;
    this.body = init.body;
  }

  isQuota(): boolean {
    return this.status === 429 && this.type !== undefined && QUOTA_TYPES.includes(this.type);
  }
}

/** Comma-joined, each item URL-encoded; the comma itself stays literal. */
const list = (items: string[]): string => items.map(encodeURIComponent).join(',');

interface RequestOptions {
  makeBody?: () => FormData;
  deadline?: number;
  timeoutMs?: number;
  binary?: boolean;
  external?: boolean;
  accept?: string;
  maxBytes?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function allowanceFromBody(body: unknown): Allowance | undefined {
  if (!isRecord(body) || !isRecord(body.allowance)) {
    return undefined;
  }
  const a = body.allowance;
  if (typeof a.limit !== 'number') {
    return undefined;
  }
  return {
    limit: a.limit,
    used: Number(a.used ?? 0),
    remaining: Number(a.remaining ?? 0),
    resetsAt: String(a.resets_at ?? ''),
  };
}

function allowanceFromHeaders(headers: Headers): Allowance | undefined {
  const limit = headers.get('X-Allowance-Limit');
  const remaining = headers.get('X-Allowance-Remaining');
  if (limit === null || remaining === null) {
    return undefined;
  }
  const reset = Number(headers.get('X-Allowance-Reset'));
  return {
    limit: Number(limit),
    used: Number(limit) - Number(remaining),
    remaining: Number(remaining),
    resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : '',
  };
}

/** Reads a body of at most `maxBytes`: refused up front by Content-Length, and counted while it streams. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(DOWNLOAD_TOO_LARGE);
  }
  if (response.body === null) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(DOWNLOAD_TOO_LARGE);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class EfApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly client: string;
  private readonly repo?: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly maxDownloadBytes: number;

  constructor(opts: EfApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.client = opts.client;
    this.repo = opts.repo;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.uploadTimeoutMs = opts.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.maxDownloadBytes = opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  }

  async uploadFont(path: string): Promise<string> {
    const bytes = await readFile(path);
    const buildForm = (): FormData => {
      const form = new FormData();
      form.append('font', new Blob([new Uint8Array(bytes)]), basename(path));
      return form;
    };
    const { body } = await this.request('POST', '/font', { makeBody: buildForm, timeoutMs: this.uploadTimeoutMs });
    return String(this.contents(body).id);
  }

  async inspect(fontId: string): Promise<{ id: string; status: string; allowance: Allowance | null }> {
    const { body, headers } = await this.request('POST', `/font/${encodeURIComponent(fontId)}/inspect`);
    const contents = this.contents(body);
    return {
      id: String(contents.id),
      status: String(contents.status),
      allowance: allowanceFromHeaders(headers) ?? allowanceFromBody(body) ?? null,
    };
  }

  async inspection(id: string): Promise<Inspection> {
    return this.fetchInspection(id);
  }

  async waitForInspection(id: string, opts: { timeoutMs: number }): Promise<Inspection> {
    const deadline = this.now() + opts.timeoutMs;
    let delay = POLL_START_MS;
    for (;;) {
      const inspection = await this.fetchInspection(id, deadline);
      if (inspection.status === 'succeeded' || inspection.status === 'failed') {
        return inspection;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for inspection ${id} after ${Math.round(opts.timeoutMs / 1000)} seconds.`);
      }
      await this.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, POLL_CAP_MS);
    }
  }

  async fontfaceKit(fontId: string, formats: string[]): Promise<string> {
    const { body } = await this.request(
      'GET',
      `/font/${encodeURIComponent(fontId)}/convert/fontface?targetformats=${list(formats)}`,
    );
    return String(this.contents(body).id);
  }

  async kitStatus(kitId: string): Promise<{ status: string; downloadurl: string | null }> {
    return this.fetchKit(kitId);
  }

  private async fetchKit(kitId: string, deadline?: number): Promise<{ status: string; downloadurl: string | null }> {
    const { body } = await this.request('GET', `/font/convert/schedule?id=${encodeURIComponent(kitId)}`, { deadline });
    const contents = this.contents(body);
    const schedule = isRecord(contents.schedule) ? contents.schedule : {};
    return {
      status: String(schedule.status ?? ''),
      downloadurl: typeof contents.downloadurl === 'string' && contents.downloadurl !== '' ? contents.downloadurl : null,
    };
  }

  async waitForKit(kitId: string, opts: { timeoutMs: number }): Promise<string> {
    const deadline = this.now() + opts.timeoutMs;
    let delay = POLL_START_MS;
    for (;;) {
      const kit = await this.fetchKit(kitId, deadline);
      if (kit.status === 'SUCCESS') {
        if (kit.downloadurl === null) {
          throw new Error(`The @font-face kit ${kitId} finished without a download link.`);
        }
        return kit.downloadurl;
      }
      if (kit.status === 'FAILED' || kit.status === 'EXPIRED') {
        throw new Error(`The @font-face kit ${kitId} ${kit.status === 'FAILED' ? 'failed to build' : 'expired'} (${kit.status}).`);
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for kit ${kitId} after ${Math.round(opts.timeoutMs / 1000)} seconds (last status: ${kit.status || 'unknown'}).`,
        );
      }
      await this.sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, POLL_CAP_MS);
    }
  }

  async subset(fontId: string, presets: string[], targetformat?: string): Promise<Uint8Array> {
    let path = `/font/${encodeURIComponent(fontId)}/subset?preset=${list(presets)}&binaryresult=true`;
    if (targetformat) {
      path += `&targetformat=${encodeURIComponent(targetformat)}`;
    }
    const { body } = await this.request('GET', path, { binary: true, accept: 'application/octet-stream, application/json' });
    return body as Uint8Array;
  }

  /** The subset presets a caller can pass to `subset`. Cheap and not rate limited: also used to verify the key. */
  async subsetRanges(): Promise<SubsetRange[]> {
    const { body } = await this.request('GET', '/font/subset/ranges');
    const ranges = this.contents(body).ranges;
    if (!Array.isArray(ranges)) {
      throw new EfApiError('Unexpected response from the Everything Fonts API.', { status: 200, body });
    }
    return ranges.filter(isRecord).map((range) => ({
      id: String(range.id ?? ''),
      label: String(range.label ?? ''),
      category: String(range.category ?? ''),
    }));
  }

  /** Fetches a signed URL: no API credentials or client headers are sent. */
  async download(url: string): Promise<Uint8Array> {
    const { body } = await this.request('GET', url, {
      binary: true,
      external: true,
      timeoutMs: this.uploadTimeoutMs,
      maxBytes: this.maxDownloadBytes,
    });
    return body as Uint8Array;
  }

  private async fetchInspection(id: string, deadline?: number): Promise<Inspection> {
    const { body } = await this.request('GET', `/inspections/${encodeURIComponent(id)}`, { deadline });
    return this.contents(body) as unknown as Inspection;
  }

  private contents(body: unknown): Record<string, unknown> {
    if (isRecord(body) && isRecord(body.contents)) {
      return body.contents;
    }
    throw new EfApiError('Unexpected response from the Everything Fonts API.', { status: 200, body });
  }

  private headers(accept = 'application/json'): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${this.apiKey}`,
      Accept: accept,
      'X-EverythingFonts-Client': this.client,
    });
    if (this.repo) {
      headers.set('X-EverythingFonts-Repo', repoHash(this.repo));
    }
    return headers;
  }

  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('***') : text;
  }

  /** Removes a signed URL, its query string and each query value from text. */
  private scrubUrl(text: string, url: string): string {
    const parts: string[] = [url];
    try {
      const parsed = new URL(url);
      parts.push(parsed.search, parsed.search.replace(/^\?/, ''));
      for (const value of parsed.searchParams.values()) {
        parts.push(value, encodeURIComponent(value));
      }
    } catch {
      // not a parseable URL: the full string is still removed
    }
    let result = text;
    for (const part of parts.filter((p) => p.length > 1).sort((a, b) => b.length - a.length)) {
      result = result.split(part).join('***');
    }
    return result;
  }

  private scrubBody(body: unknown): unknown {
    if (typeof body === 'string') {
      return this.scrub(body);
    }
    if (body === null || body === undefined) {
      return body;
    }
    return JSON.parse(this.scrub(JSON.stringify(body)));
  }

  private retryDelayMs(headers: Headers): number {
    const raw = headers.get('Retry-After');
    if (raw === null || raw.trim() === '') {
      return DEFAULT_RETRY_AFTER_SECONDS * 1000;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
      return seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_SECONDS * 1000;
    }
    const date = Date.parse(raw);
    if (Number.isNaN(date)) {
      return DEFAULT_RETRY_AFTER_SECONDS * 1000;
    }
    return Math.max(date - this.now(), 0);
  }

  private async request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ body: unknown; headers: Headers }> {
    const { makeBody, deadline, binary = false, external = false, accept } = options;
    const clean = (text: string): string => (external ? this.scrubUrl(this.scrub(text), path) : this.scrub(text));
    const perRequestMs = options.timeoutMs ?? this.requestTimeoutMs;
    for (let attempt = 0; ; attempt++) {
      const timeoutMs =
        deadline === undefined ? perRequestMs : Math.max(1, Math.min(perRequestMs, deadline - this.now()));
      let response: Response;
      try {
        response = await fetch(external ? path : `${this.baseUrl}${path}`, {
          method,
          headers: external ? new Headers() : this.headers(accept),
          body: makeBody?.(),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new EfApiError(
          external
            ? 'Could not download the built files \u2014 try again.'
            : this.scrub(
            timedOut
              ? `The Everything Fonts API did not answer within ${Math.round(timeoutMs / 1000)} seconds.`
              : `Could not reach the Everything Fonts API: ${reason}`,
          ),
          { status: 0 },
        );
      }

      if (response.ok && binary) {
        const bytes =
          options.maxBytes === undefined ? new Uint8Array(await response.arrayBuffer()) : await readCapped(response, options.maxBytes);
        return { body: bytes, headers: response.headers };
      }

      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = text;
      }

      if (response.ok) {
        return { body, headers: response.headers };
      }

      const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
      const message =
        (typeof error?.message === 'string' && error.message) ||
        (isRecord(body) && typeof body.message === 'string' && body.message) ||
        `HTTP ${response.status}`;
      const apiError = external
        ? new EfApiError(`Downloading the built files failed (HTTP ${response.status}). The link may have expired; re-run the job.`, {
            status: response.status,
            body: clean(text).slice(0, 200),
          })
        : new EfApiError(this.scrub(`Everything Fonts API error (${response.status}): ${message}`), {
            status: response.status,
            type: typeof error?.type === 'string' ? error.type : undefined,
            allowance: allowanceFromBody(body) ?? allowanceFromHeaders(response.headers),
            body: this.scrubBody(body),
          });

      if (response.status !== 429 || apiError.isQuota() || attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw apiError;
      }

      const waitMs = this.retryDelayMs(response.headers);
      if (waitMs > MAX_WAIT_MS || (deadline !== undefined && this.now() + waitMs >= deadline)) {
        throw new EfApiError(
          this.scrub(`Everything Fonts API is rate limiting this key; try again in ${Math.ceil(waitMs / 1000)} seconds.`),
          { status: 429, body: apiError.body },
        );
      }
      await this.sleep(waitMs);
    }
  }
}
