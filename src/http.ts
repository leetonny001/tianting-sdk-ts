/** HTTP 传输层接口：生产环境用 fetch，测试用 FakeHttp（PRD-chat 第 4.5 节）。超时由调用方用 Clock 控制，这里不做定时。 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  /** Bearer token 只放在这里，不进 URL（第 4.2 节）。 */
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** 调用方放弃请求时中止。 */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpTransport {
  /** 收到任何状态码都正常返回；连不上、被中止时 reject。 */
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * 基于标准 fetch 的传输层（浏览器和 Node 22+ 都自带）。不跟随重定向（Bearer 不能带到别的地址），不带 Cookie，不走缓存。
 */
export class FetchHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await globalThis.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    return { status: res.status, text: await res.text() };
  }
}
