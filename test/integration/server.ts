// 集成测试用的真实 im-server：编译 server/cmd/im-server，以测试模式启动在随机端口。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ADMIN_KEY = 'sdk-it-admin-key-0123456789abcdef';
// 只给这个测试服务端用的调用方（PRD-admin F-KEY-02）：第二批管理接口不接受旧 X-Admin-Key。
const CALLER_ID = 'sdk-it';
const CALLER_SECRET = 'sdk-it-caller-secret-0123456789abcdef';
const CALLER_SCOPES = ['user.ban', 'msg.delete', 'mute.write'];
/** 打开第二批功能（IM_V13_ADMIN_FEATURES）需要的环境变量。 */
export const MODERATION_ENV = {
  IM_V13_ADMIN_FEATURES: '1',
  IM_QUARANTINE_KEY: 'sdk-it-quarantine-key-0123456789abcdef',
};

export interface RunningServer {
  wsURL: string;
  admin(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  /** 用调用方签名调用管理接口（protocol/ADMIN.md「鉴权」）。 */
  signed(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
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

/**
 * 服务端源码目录：环境变量 TIANTING_SERVER_DIR，否则找同级目录的 tianting-server（或旧名 im-mvp）检出。
 */
function serverDir(): string {
  const env = process.env.TIANTING_SERVER_DIR;
  const candidates = env ? [env] : ['../tianting-server/server', '../im-mvp/server'];
  for (const c of candidates) {
    const dir = resolve(c);
    if (existsSync(join(dir, 'cmd/im-server'))) return dir;
  }
  throw new Error(`找不到 tianting-server 的 server 目录（试过 ${candidates.join('、')}），请设置 TIANTING_SERVER_DIR`);
}

function build(): string {
  if (built) return built;
  const dir = mkdtempSync(join(tmpdir(), 'im-sdk-it-'));
  built = join(dir, 'im-server');
  execFileSync('go', ['build', '-o', built, './cmd/im-server'], {
    cwd: serverDir(),
    stdio: 'inherit',
  });
  return built;
}

export async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const bin = build();
  const port = await freePort();
  const adminPort = await freePort(); // 管理接口在单独的端口上（tianting-server PRD-admin F-KEY-01）
  const dir = mkdtempSync(join(tmpdir(), 'im-sdk-db-'));
  const callers = join(dir, 'callers.json');
  writeFileSync(
    callers,
    JSON.stringify([
      {
        id: CALLER_ID,
        alg: 'hmac-sha256',
        secret: Buffer.from(CALLER_SECRET).toString('base64'),
        scopes: CALLER_SCOPES,
      },
    ]),
    { mode: 0o600 },
  );
  const proc: ChildProcess = spawn(bin, [], {
    env: {
      ...process.env,
      IM_ADDR: `127.0.0.1:${port}`,
      IM_ADMIN_ADDR: `127.0.0.1:${adminPort}`,
      IM_DB: join(dir, 'im.db'),
      IM_ADMIN_KEY: ADMIN_KEY,
      IM_JWT_SECRET: 'sdk-it-jwt-secret-0123456789',
      IM_TEST_MODE: '1',
      IM_METRICS_ADDR: 'off',
      IM_ADMIN_CALLERS: callers,
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
    const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
      method,
      headers: { 'X-Admin-Key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  const signed = async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
    const toSign = [method, path, timestamp, nonce, hash, 'it', '', ''].join('\n');
    const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-IM-Caller': CALLER_ID,
        'X-IM-Timestamp': timestamp,
        'X-IM-Nonce': nonce,
        'X-IM-Operator': 'it',
        'X-IM-Signature': createHmac('sha256', CALLER_SECRET).update(toSign, 'utf8').digest('base64url'),
      },
      body: raw || undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    wsURL: `ws://127.0.0.1:${port}/ws`,
    admin,
    signed,
    token: async (userId) => String((await admin('POST', '/admin/users/token', { userId })).token),
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}
