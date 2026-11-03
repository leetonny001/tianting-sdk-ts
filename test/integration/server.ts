// 集成测试用的真实 im-server：编译 server/cmd/im-server，以测试模式启动在随机端口。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ADMIN_KEY = 'sdk-it-admin-key-0123456789abcdef';

export interface RunningServer {
  wsURL: string;
  admin(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  token(userId: string): Promise<string>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let built: string | undefined;

function build(): string {
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), 'im-sdk-it-'));
  built = join(dir, 'im-server');
  execFileSync('go', ['build', '-o', built, './cmd/im-server'], {
    cwd: new URL('../../../server', import.meta.url),
    stdio: 'inherit',
  });
  return built;
}

export async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const bin = build();
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'im-sdk-db-'));
  const proc: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      IM_ADDR: `127.0.0.1:${port}`,
      IM_DB: join(dir, 'im.db'),
      IM_ADMIN_KEY: ADMIN_KEY,
      IM_JWT_SECRET: 'sdk-it-jwt-secret-0123456789',
      IM_TEST_MODE: '1',
      IM_METRICS_ADDR: 'off',
      ...env,
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) break;
    } catch {
      /* 还没起来 */
    }
    if (i > 100) throw new Error('im-server did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    wsURL: `ws://127.0.0.1:${port}/ws`,
    admin,
    token: async (userId) => String((await admin('POST', '/admin/users/token', { userId })).token),
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}
