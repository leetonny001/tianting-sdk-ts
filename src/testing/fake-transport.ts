import type { Transport, TransportConnection, TransportHandlers } from '../transport.js';

/** 一条假连接：记录客户端发出的帧，测试代码可以脚本化地下发帧、打开、关闭。 */
export class FakeConnection implements TransportConnection {
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(
    readonly url: string,
    private readonly h: TransportHandlers,
  ) {}

  send(text: string): void {
    if (!this.closedWith) this.sent.push(text);
  }

  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
  }

  /** 模拟握手完成。 */
  open(): void {
    this.h.onOpen();
  }

  /** 模拟服务端下发一帧。 */
  receive(frame: unknown): void {
    this.h.onMessage(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** 模拟连接结束（服务端关闭或断网，断网用 1006）。 */
  drop(code = 1006, reason = ''): void {
    this.h.onClose(code, reason);
  }

  /** 客户端发出的帧（已解析）。 */
  frames(): Array<{ id?: string; cmd: string; data?: Record<string, unknown> }> {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** 最后一个指定命令的请求。 */
  last(cmd: string): { id: string; cmd: string; data: Record<string, unknown> } {
    const f = this.frames()
      .filter((x) => x.cmd === cmd)
      .at(-1);
    if (!f) throw new Error(`no ${cmd} frame sent`);
    return f as { id: string; cmd: string; data: Record<string, unknown> };
  }

  /** 对最后一个指定命令的请求回 ack。 */
  ack(cmd: string, data: unknown = {}): void {
    this.receive({ id: this.last(cmd).id, cmd: 'ack', data });
  }

  ackError(cmd: string, code: number, msg = 'error'): void {
    this.receive({ id: this.last(cmd).id, cmd: 'ack', error: { code, msg } });
  }
}

/** 假传输层（FE-007）：每次 open 产生一条 FakeConnection，测试代码通过 connections 控制它们。 */
export class FakeTransport implements Transport {
  readonly connections: FakeConnection[] = [];

  open(url: string, handlers: TransportHandlers): TransportConnection {
    const c = new FakeConnection(url, handlers);
    this.connections.push(c);
    return c;
  }

  /** 最近一条连接。 */
  get current(): FakeConnection {
    const c = this.connections.at(-1);
    if (!c) throw new Error('no connection opened');
    return c;
  }
}
