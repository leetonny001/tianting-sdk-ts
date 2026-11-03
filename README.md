# 天听 SDK（TypeScript）

天听 IM 的统一 SDK：H5 和 PC 共用的通信网络层和数据层（连接与重连、首帧鉴权、收发、同步、会话、未读、已读），不依赖任何 UI 框架。

- 服务端、协议、需求文档：[tianting-server](https://github.com/leetonny001/tianting-server)
- SDK 设计说明（三套 SDK 的行为基准）：tianting-server 的 `docs/sdk/README.md`
- 同一套行为规则的其他实现：[tianting-sdk-kotlin](https://github.com/leetonny001/tianting-sdk-kotlin)、[tianting-sdk-swift](https://github.com/leetonny001/tianting-sdk-swift)

## 开发

需要 Node 22.12+。

```bash
npm install
npm test                       # 单元测试（假传输层 + 假时钟）
npm run lint && npm run typecheck && npm run format:check
npm run build
```

## 协议副本

`protocol/` 是服务端仓库协议文件的副本（错误码、帧 Schema、共享测试用例），不要直接改。服务端协议变更后：

```bash
scripts/sync-protocol.sh       # 默认从同级目录 ../tianting-server 同步，并重新生成 src/errors.gen.ts
```

## 集成测试

集成测试会编译并启动真实的服务端，需要 Go 1.27+ 和 tianting-server 的源码：

```bash
npm run test:integration       # 默认找同级目录 ../tianting-server/server
TIANTING_SERVER_DIR=/path/to/tianting-server/server npm run test:integration
```

CI 暂不跑集成测试：tianting-server 是私有仓库，需要配置读取凭证（待授权）。
