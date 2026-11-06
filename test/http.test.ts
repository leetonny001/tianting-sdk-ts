// FE-600：假 HTTP 和 fetch 传输层。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchHttpTransport } from '../src/index.js';
import { FakeHttp } from '../src/testing/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('FakeHttp', () => {
  it('记录请求，由测试代码决定响应；可以迟到，可以失败', async () => {
    const http = new FakeHttp();
    const a = http.request({
      method: 'POST',
      url: 'https://x.test/v1/a',
      headers: { Authorization: 'Bearer t' },
      body: '{"k":1}',
    });
    const b = http.request({ method: 'GET', url: 'https://x.test/v1/b', headers: {} });
    expect(http.pending.map((c) => c.path)).toEqual(['/v1/a', '/v1/b']);
    expect(http.last('/v1/a').json).toEqual({ k: 1 });
    expect(http.last('/v1/a').bearer).toBe('t');
    http.last('/v1/a').respond(200, { ok: true });
    await expect(a).resolves.toEqual({ status: 200, text: '{"ok":true}' });
    http.last('/v1/b').fail();
    await expect(b).rejects.toThrow('network error');
    expect(http.pending).toEqual([]);
    expect(() => http.last('/v1/none')).toThrow('no request');
  });
});

describe('FetchHttpTransport', () => {
  it('不跟随重定向，不带 Cookie，不走缓存；任何状态码都正常返回', async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":4019}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new FetchHttpTransport().request({
      method: 'POST',
      url: 'https://x.test/a',
      headers: {},
      body: '{}',
    });
    expect(r).toEqual({ status: 401, text: '{"code":4019}' });
    expect(fetchMock.mock.calls[0]).toMatchObject([
      'https://x.test/a',
      { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' },
    ]);
  });
});
