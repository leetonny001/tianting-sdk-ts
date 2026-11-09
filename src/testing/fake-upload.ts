import { sizeOf, type UploadBody, type UploadTransport } from '../files.js';

/** 一次假 PUT：测试代码决定进度和结果。 */
export class FakeUploadCall {
  settled = false;
  private resolve!: (status: number) => void;
  private reject!: (e: Error) => void;
  readonly promise: Promise<number>;

  constructor(
    readonly url: string,
    readonly headers: Readonly<Record<string, string>>,
    readonly body: UploadBody,
    readonly signal: AbortSignal | undefined,
    private readonly progress: ((sent: number) => void) | undefined,
  ) {
    this.promise = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
    signal?.addEventListener('abort', () => this.fail('aborted'), { once: true });
  }

  get size(): number {
    return sizeOf(this.body);
  }

  get aborted(): boolean {
    return this.signal?.aborted === true;
  }

  /** 报告已发送的字节数。 */
  sent(n: number): void {
    this.progress?.(n);
  }

  /** 结束：默认 200，全部字节已发送。 */
  respond(status = 200): void {
    if (this.settled) return;
    this.settled = true;
    if (status >= 200 && status < 300) this.progress?.(this.size);
    this.resolve(status);
  }

  fail(message = 'network error'): void {
    if (this.settled) return;
    this.settled = true;
    this.reject(new Error(message));
  }
}

/** 假的对象存储上传（PRD-chat 第 4.5 节）：记录每个 PUT。auto 为 true 时立即回 200。 */
export class FakeUpload implements UploadTransport {
  readonly calls: FakeUploadCall[] = [];
  auto = false;

  put(req: Parameters<UploadTransport['put']>[0]): Promise<number> {
    const call = new FakeUploadCall(req.url, req.headers, req.body, req.signal, req.onProgress);
    this.calls.push(call);
    if (this.auto) call.respond(200);
    return call.promise;
  }

  get pending(): FakeUploadCall[] {
    return this.calls.filter((c) => !c.settled);
  }
}
