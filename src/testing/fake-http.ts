import type { HttpRequest, HttpResponse, HttpTransport } from '../http.js';

/** 一个假请求：测试代码决定它什么时候、以什么结果结束，迟到的响应也能这样构造。 */
export class FakeHttpCall {
  settled = false;
  private resolve!: (r: HttpResponse) => void;
  private reject!: (e: Error) => void;
  readonly promise: Promise<HttpResponse>;

  constructor(readonly req: HttpRequest) {
    this.promise = new Promise((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  get path(): string {
    return new URL(this.req.url).pathname;
  }

  /** 请求体（已解析）。 */
  get json(): Record<string, unknown> {
    return this.req.body ? (JSON.parse(this.req.body) as Record<string, unknown>) : {};
  }

  get bearer(): string | undefined {
    return this.req.headers['Authorization']?.replace(/^Bearer /, '');
  }

  /** 回一个响应。已经结束的请求再回也不报错（真实网络上迟到的响应就是这样）。 */
  respond(status: number, body: unknown = {}): void {
    this.settled = true;
    this.resolve({ status, text: typeof body === 'string' ? body : JSON.stringify(body) });
  }

  /** 回错误响应，形状同服务端 ErrorResponse。 */
  respondError(status: number, code: number, extra: { reason?: string; details?: object; msg?: string } = {}): void {
    this.respond(status, { code, msg: extra.msg ?? 'error', ...extra });
  }

  /** 模拟网络错误。 */
  fail(message = 'network error'): void {
    this.settled = true;
    this.reject(new Error(message));
  }
}

/**
 * 假 HTTP（PRD-chat 第 4.5 节，现有 FakeTransport 只有 WS）：记录每个请求，默认一直不回应答，由测试代码控制。
 * 设置 onRequest 可以自动应答，用来搭假服务端。不理会 signal：被放弃的请求，测试代码还能让它的响应迟到，SDK 必须丢弃。
 */
export class FakeHttp implements HttpTransport {
  readonly calls: FakeHttpCall[] = [];
  onRequest: ((call: FakeHttpCall) => void) | null = null;

  request(req: HttpRequest): Promise<HttpResponse> {
    const call = new FakeHttpCall(req);
    this.calls.push(call);
    this.onRequest?.(call);
    return call.promise;
  }

  /** 发到某个路径的全部请求（按发出顺序）。 */
  to(path: string): FakeHttpCall[] {
    return this.calls.filter((c) => c.path === path);
  }

  /** 发到某个路径的最后一个请求。 */
  last(path: string): FakeHttpCall {
    const c = this.to(path).at(-1);
    if (!c) throw new Error(`no request to ${path}`);
    return c;
  }

  /** 还没有回应答的请求。 */
  get pending(): FakeHttpCall[] {
    return this.calls.filter((c) => !c.settled);
  }
}
