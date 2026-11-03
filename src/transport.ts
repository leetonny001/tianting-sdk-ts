/** 传输层接口：生产环境用 WebSocket，测试用 FakeTransport（FE-007）。 */
export interface Transport {
  open(url: string, handlers: TransportHandlers): TransportConnection;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  /** 连接结束：code 为关闭码；没有收到关闭帧（断网等）时为 1006。 */
  onClose(code: number, reason: string): void;
}

export interface TransportConnection {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * 基于标准 WebSocket 的传输层（浏览器和 Node 22+ 都自带）。
 * 浏览器的 WebSocket 对下行帧大小没有限制，满足 C-07（500 个会话的 convs 应答约 125KB）。
 */
export class WebSocketTransport implements Transport {
  open(url: string, h: TransportHandlers): TransportConnection {
    const ws = new WebSocket(url);
    let closed = false;
    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      h.onClose(code, reason);
    };
    ws.onopen = () => h.onOpen();
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') h.onMessage(e.data);
    };
    ws.onclose = (e) => finish(e.code || 1006, e.reason);
    ws.onerror = () => {
      /* 错误之后总会触发 close，在那里统一处理 */
    };
    return {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: (code, reason) => {
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      },
    };
  }
}
