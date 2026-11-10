// 图片和文件（PRD-chat 第 6 节 F-FILE-01、03、04、07，第 13.1 节）：/v1/files/* 接口、上传、取地址。
// 图片处理（压缩、缩略图、去 EXIF）不在 SDK（R-CF-24）：App 处理好再交给 sendImage。
// 预签名地址和文件名不进日志、不进错误信息（F-FILE-04 规则 5，第 13.1 节）。
import { AccountError, AccountNetworkError } from './account.js';
import { realClock, type Clock } from './clock.js';
import { FetchHttpTransport, type HttpRequest, type HttpTransport } from './http.js';
import { silentLogger, type Logger } from './logger.js';

/** 可以上传的内容。H5 一般是 File / Blob；只在内存里（F-FILE-07 规则 2，刷新就没有了）。 */
export type UploadBody = Blob | ArrayBuffer | Uint8Array;

export interface UploadData {
  data: UploadBody;
  /** 声明的类型，签进 PUT 地址（RC2-08）。 */
  mime: string;
}

/** App 处理好的图片（F-FILE-02 规则 2～4）：原图和缩略图都已重新编码、去掉 EXIF；GIF 不重新编码。 */
export interface ProcessedImage {
  original: UploadData;
  /** 长边 ≤ 480，≤ 512 KiB（F-FILE-02 规则 3）。 */
  thumb: UploadData;
  width: number;
  height: number;
  /** 只存服务端数据库，不显示给对方；默认 "image"。 */
  name?: string;
}

/** 要发送的文件（F-FILE-03）：内容不重新编码。 */
export interface FileInput {
  data: UploadBody;
  name: string;
  /** 不知道时用 application/octet-stream。 */
  mime?: string;
}

export type FileVariant = 'original' | 'thumb';

export interface FileUrlItem {
  fileId: string;
  variant: FileVariant;
}

/** 一项的结果：有地址，或者 code（4048：不可访问，和不存在相同）。地址只在内存里用，不要持久化、打日志。 */
export interface FileUrlResult extends FileUrlItem {
  url?: string;
  expiresAt?: number;
  code?: number;
}

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export interface UploadRequest {
  kind: 'image' | 'file' | 'avatar';
  name: string;
  size: number;
  mime: string;
  thumb?: { size: number; mime: string };
}

export interface UploadResponse {
  fileId: string;
  put: PresignedPut;
  thumbPut?: PresignedPut;
}

export interface CompleteResponse {
  fileId: string;
  size: number;
  mime: string;
  width?: number;
  height?: number;
}

/**
 * 带 Bearer 调 /v1/*。AccountClient 实现了它（4011 按 F-ACC-03 规则 7 重试）；演示模式用 StaticTokenAuth。
 * 失败时抛 AccountError（有错误码）或 AccountNetworkError（没有拿到错误码，包括被中止）。
 */
export interface FileAuth {
  authorized<T>(
    method: HttpRequest['method'],
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<T>;
}

/** 演示模式（connect(token)）的 FileAuth：固定 token，没有刷新。服务端的文件接口不要求 sid。 */
export class StaticTokenAuth implements FileAuth {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly http: HttpTransport = new FetchHttpTransport(),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async authorized<T>(
    method: HttpRequest['method'],
    path: string,
    body?: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let status: number;
    let text: string;
    try {
      ({ status, text } = await this.http.request({
        method,
        url: this.baseUrl + path,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }));
    } catch {
      throw new AccountNetworkError();
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = undefined;
    }
    if (status >= 200 && status < 300 && data !== undefined) return data as T;
    const e = data as { code?: unknown; msg?: unknown; reason?: unknown; details?: unknown } | undefined;
    if (typeof e?.code !== 'number') throw new AccountNetworkError(`status ${status}`);
    throw new AccountError(
      status,
      e.code,
      typeof e.msg === 'string' ? e.msg : '',
      typeof e.reason === 'string' ? e.reason : undefined,
      typeof e.details === 'object' && e.details !== null ? (e.details as Record<string, unknown>) : undefined,
    );
  }
}

/** 直接 PUT 到对象存储（F-FILE-01 规则 2）。生产 H5 用 XhrUploadTransport（有进度），Node 和测试用 FetchUploadTransport 或假的。 */
export interface UploadTransport {
  /** 返回 HTTP 状态码；连不上、被中止时 reject。onProgress 是已发送的字节数。 */
  put(req: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: UploadBody;
    signal?: AbortSignal;
    onProgress?: (sent: number) => void;
  }): Promise<number>;
}

// 浏览器自己设置这几个头，脚本设置会被拒绝；签名里的 Content-Length 由请求体决定。
const FORBIDDEN_HEADERS = new Set(['content-length', 'host']);

function settable(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())));
}

/** 基于 fetch 的上传：没有中途进度，结束时报一次。不跟随重定向，不带 Cookie。 */
export class FetchUploadTransport implements UploadTransport {
  async put(req: Parameters<UploadTransport['put']>[0]): Promise<number> {
    const res = await globalThis.fetch(req.url, {
      method: 'PUT',
      headers: settable(req.headers),
      body: req.body as BodyInit,
      signal: req.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) req.onProgress?.(sizeOf(req.body));
    return res.status;
  }
}

/** 浏览器的 XMLHttpRequest 上传：有进度（第 13.2 节）。 */
export class XhrUploadTransport implements UploadTransport {
  put(req: Parameters<UploadTransport['put']>[0]): Promise<number> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', req.url);
      xhr.withCredentials = false;
      for (const [k, v] of Object.entries(settable(req.headers))) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => req.onProgress?.(e.loaded);
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => reject(new Error('upload failed')); // 不带地址
      xhr.onabort = () => reject(new Error('upload aborted'));
      if (req.signal?.aborted) {
        reject(new Error('upload aborted'));
        return;
      }
      req.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(req.body as XMLHttpRequestBodyInit);
    });
  }
}

export function sizeOf(b: UploadBody): number {
  return b instanceof Uint8Array || b instanceof ArrayBuffer ? b.byteLength : b.size;
}

/** 上传的 PUT 失败（对象存储拒绝或网络错误）。不带地址。 */
export class UploadPutError extends Error {
  constructor(readonly status: number) {
    super(status ? `upload put status ${status}` : 'upload put failed');
    this.name = 'UploadPutError';
  }
}

export interface FileClientOptions {
  auth: FileAuth;
  upload?: UploadTransport;
  clock?: Clock;
  logger?: Logger;
  random?: () => number;
}

/** 单次最多 50 项（F-FILE-04 规则 1，超出 4131）。 */
export const URLS_BATCH = 50;
/** complete 返回 5032：退避重试 3 次再转失败（F-FILE-07 异常）。 */
export const COMPLETE_RETRIES = 3;
const COMPLETE_BACKOFF_MS = 1_000;
const JITTER = 0.2;
/** 地址剩余不到这么久就不再复用，重新申请（下载要时间）。 */
const URL_REUSE_MARGIN_MS = 15_000;

interface PendingUrl {
  item: FileUrlItem;
  resolve: (r: FileUrlResult) => void;
  reject: (e: Error) => void;
  /** 排队时这个文件被 forget 过几次：之后又被 forget 的，迟到的地址不进缓存（问题 33）。 */
  gen: number;
}

/**
 * /v1/files/* 接口（第 13.1 节）。一个事件循环内的 getFileUrls 合并成一批（每批 ≤ 50，F-FILE-04 规则 6），
 * 地址缓存在内存里，没到期前同一个 fileId + variant 不再申请（AC-FILE-04-10）；不持久化，不打日志。
 */
export class FileClient {
  readonly auth: FileAuth;
  readonly upload: UploadTransport;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly random: () => number;
  private urls = new Map<string, { url: string; expiresAt: number }>();
  private queued: PendingUrl[] = [];
  private flushScheduled = false;
  private inflight = new Map<string, Promise<FileUrlResult>>();
  private forgotten = new Map<string, number>();

  constructor(o: FileClientOptions) {
    this.auth = o.auth;
    this.upload = o.upload ?? new FetchUploadTransport();
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? silentLogger;
    this.random = o.random ?? Math.random;
  }

  /** POST /v1/files/uploads。4292、4290（uploadPendingLimit）不重试，原样抛出（F-FILE-01 规则 6、6a）。 */
  createUpload(req: UploadRequest, signal?: AbortSignal): Promise<UploadResponse> {
    return this.auth.authorized<UploadResponse>('POST', '/v1/files/uploads', req, { signal });
  }

  /** PUT 一个变体：签进去的头原样带上（RC2-08）。非 2xx 抛 UploadPutError。 */
  async put(
    target: PresignedPut,
    body: UploadBody,
    signal?: AbortSignal,
    onProgress?: (sent: number) => void,
  ): Promise<void> {
    let status: number;
    try {
      status = await this.upload.put({ url: target.url, headers: target.headers, body, signal, onProgress });
    } catch {
      throw new UploadPutError(0);
    }
    if (status < 200 || status >= 300) {
      this.log.warn(`files: put status ${status}`);
      throw new UploadPutError(status);
    }
  }

  /** POST /v1/files/{id}/complete。5032 退避重试 3 次（1、2、4 秒，±20%），再失败抛出。 */
  async complete(fileId: string, signal?: AbortSignal): Promise<CompleteResponse> {
    for (let i = 0; ; i++) {
      try {
        return await this.auth.authorized<CompleteResponse>(
          'POST',
          `/v1/files/${encodeURIComponent(fileId)}/complete`,
          undefined,
          {
            signal,
          },
        );
      } catch (err) {
        if (!(err instanceof AccountError) || err.code !== 5032 || i >= COMPLETE_RETRIES || signal?.aborted) throw err;
        this.log.debug(`files: complete 5032, retry ${i + 1}`);
        const base = COMPLETE_BACKOFF_MS * 2 ** i;
        await this.sleep(base * (1 + (this.random() * 2 - 1) * JITTER), signal);
      }
    }
  }

  /** DELETE /v1/files/uploads/{id}（cancelUpload）：幂等，失败只记日志（尽力而为，名额靠 PUT 地址过期释放）。 */
  async cancelUpload(fileId: string): Promise<void> {
    try {
      await this.auth.authorized('DELETE', `/v1/files/uploads/${encodeURIComponent(fileId)}`);
    } catch (err) {
      this.log.warn(`files: cancel upload failed: ${err instanceof AccountError ? err.code : 'network'}`);
    }
  }

  /**
   * 取下载地址（F-FILE-04）：同一个事件循环内的调用合并成一批，每批 ≤ 50；没过期的地址直接用缓存。
   * 不可访问的项 code=4048，不影响其他项。网络错误或整批失败时这一批的调用都 reject。
   */
  getFileUrls(items: readonly FileUrlItem[]): Promise<FileUrlResult[]> {
    return Promise.all(items.map((i) => this.one(i)));
  }

  /** 忘掉一个文件的地址（过期、撤回时，F-FILE-06 规则 3）。 */
  forget(fileId: string): void {
    this.forgotten.set(fileId, (this.forgotten.get(fileId) ?? 0) + 1);
    for (const v of ['original', 'thumb'] as const) {
      this.urls.delete(key({ fileId, variant: v }));
      this.inflight.delete(key({ fileId, variant: v }));
    }
  }

  /** 退出登录：地址只在内存里，全部丢掉。 */
  clear(): void {
    this.urls.clear();
    this.inflight.clear();
  }

  private one(item: FileUrlItem): Promise<FileUrlResult> {
    const k = key(item);
    const hit = this.urls.get(k);
    if (hit && hit.expiresAt - this.clock.now() > URL_REUSE_MARGIN_MS) {
      return Promise.resolve({ ...item, url: hit.url, expiresAt: hit.expiresAt });
    }
    const same = this.inflight.get(k);
    if (same) return same;
    const p = new Promise<FileUrlResult>((resolve, reject) => {
      const gen = this.forgotten.get(item.fileId) ?? 0;
      this.queued.push({ item: { fileId: item.fileId, variant: item.variant }, resolve, reject, gen });
    });
    this.inflight.set(k, p);
    void p.then(
      () => this.inflight.get(k) === p && this.inflight.delete(k),
      () => this.inflight.get(k) === p && this.inflight.delete(k),
    );
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return p;
  }

  private flush(): void {
    this.flushScheduled = false;
    const all = this.queued;
    this.queued = [];
    for (let i = 0; i < all.length; i += URLS_BATCH) void this.batch(all.slice(i, i + URLS_BATCH));
  }

  private async batch(group: PendingUrl[]): Promise<void> {
    let resp: { items?: FileUrlResult[] };
    try {
      resp = await this.auth.authorized<{ items?: FileUrlResult[] }>('POST', '/v1/files/urls', {
        items: group.map((g) => g.item),
      });
    } catch (err) {
      this.log.warn(`files: urls failed: ${err instanceof AccountError ? err.code : 'network'}`);
      for (const g of group) g.reject(err instanceof Error ? err : new AccountNetworkError());
      return;
    }
    const items = Array.isArray(resp.items) ? resp.items : [];
    group.forEach((g, i) => {
      // 顺序和请求相同；不相符（不应该发生）就按 fileId + variant 找。
      const r =
        items[i]?.fileId === g.item.fileId && items[i]?.variant === g.item.variant
          ? items[i]
          : items.find((x) => x.fileId === g.item.fileId && x.variant === g.item.variant);
      if (r && typeof r.url === 'string' && typeof r.expiresAt === 'number') {
        if ((this.forgotten.get(g.item.fileId) ?? 0) === g.gen)
          this.urls.set(key(g.item), { url: r.url, expiresAt: r.expiresAt });
        g.resolve({ ...g.item, url: r.url, expiresAt: r.expiresAt });
      } else {
        g.resolve({ ...g.item, code: typeof r?.code === 'number' ? r.code : 4048 });
      }
    });
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = this.clock.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clock.clearTimeout(t);
        reject(new AccountNetworkError('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function key(i: FileUrlItem): string {
  return `${i.fileId}\u0000${i.variant}`;
}
