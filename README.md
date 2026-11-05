# 天听 SDK（TypeScript）

天听 IM 的统一 SDK：H5 和 PC 共用的通信网络层和数据层（连接与重连、首帧鉴权、收发、同步、会话、未读、已读），不依赖任何 UI 框架。

- 服务端、协议、需求文档：[tianting-server](https://github.com/leetonny001/tianting-server)
- SDK 设计说明（三套 SDK 的行为基准）：tianting-server 的 `docs/sdk/README.md`
- 同一套行为规则的其他实现：[tianting-sdk-kotlin](https://github.com/leetonny001/tianting-sdk-kotlin)、[tianting-sdk-swift](https://github.com/leetonny001/tianting-sdk-swift)

## 社交（PRD-social M3）

```ts
im.on('friends', (list) => …);                         // 好友（displayName = 备注 → 昵称 → userId，blocked 标记）
im.on('friendRequests', ({ items, unseen }) => …);     // 新的朋友（30 天内，updatedAt 倒序）+ 红点
im.on('blocks', (list) => …);
im.on('socialSettings', ({ searchable, mode, strangerMsgLimit }) => …);

await im.applyFriend(userId, { message, source, sourceRef, remark }); // → 'pending' | 'accepted'
await im.respondFriend(userId, 'accept' | 'reject', { remark });
await im.deleteFriend(userId); await im.setFriendRemark(userId, remark);
await im.block(userId); await im.unblock(userId);
im.markFriendRequestsSeen();                           // 本地红点立即清零
im.relationOf(userId);                                 // self > blocked > friend > pendingIn > pendingOut > none
await im.searchUser(keyword); await im.setSearchable(bool);
await im.getUsers(userIds);                            // 资料缓存 10 分钟，同一事件循环内合并、每批 100
await im.loadMyGroups();

// 群管理（M4）：错误里的 err.userId 指出是哪个人导致失败
const { groupId } = await im.createGroup({ members: ['bob', 'carol'] });
await im.inviteToGroup(groupId, ['dave']); // { added, failed: [{ userId, code }] }
await im.getGroupInfo(groupId); // kickFromGroup / setGroupAdmin / transferGroupOwner / updateGroup / leaveGroup / dissolveGroup
im.on('groupChanged', (id) => refreshGroupPage(id)); // 本地会话的 name、memberCount、myRole 已更新
// type === 'tip' 的消息用 tipText(msg.body.tip, me, nameOf) 生成本地文案
messageFor(cmd, code, { strangerMsgLimit });           // "命令 + 错误码"文案
```

快照读取：`friends()`、`friendRequests()`、`blocks()`、`socialSettings()`、`socialLoaded()`、`profileOf(userId)`、`displayName(userId)`。
同步规则（PRD-social 10.2 节）由纯状态机 `SocialState` 实现，跑共享用例 `protocol/vectors/social.json`（与服务端的 Go 参考客户端同一份）。失败的命令抛出 `IMError`（`code` 透传）。

## 封禁、消息删除、禁言（PRD-admin 第二批）

```ts
im.on('fatal', (r) => …);        // 封禁：{ kind: 'kicked', reason: 'suspended', code: 4012, until }，until 永久为 null；不重连
im.on('messages', (id, list) => …); // 被删的消息 deleted = true、body = {}，seq 不变；原文从内存清除
// 会话摘要：lastMsg.deleted = true 时没有 text；未读不变
im.muteState(convId);            // null，或 { scope: 'user' | 'group', groupId?, mutedUntil }（永久为 null）
im.on('muteChanged', () => …);   // muted / unmuted、auth ack、convs、发送返回 4031、到期（按服务端时间）
im.debugExport();                // 调试：内存里的会话和全部消息副本（拷贝，不含 token）
```

重连后 SDK 会重新拉一遍已加载的 seq 范围：断开期间被删除的消息不会再发 `msgDeleted`，只有 `sync` 能拿到。

## 删除失败的消息（PRD-ui G-UI-14）

```ts
im.removeFailed(convId, clientMsgId); // → boolean。只对 failed 有效，不发帧；pendingCount 减 1；本次登录内不再出现（晚到的 ack、sync 也不会）
```

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

CI 里的集成测试需要读取私有仓库 tianting-server：在 tianting-server 添加一个**只读**部署密钥（Deploy key），把私钥存为本仓库的 Actions secret `TIANTING_SERVER_DEPLOY_KEY`。没配置时 CI 跳过集成测试，只跑单元测试。

```bash
scripts/setup-ci-deploy-key.sh   # 由仓库所有者本人运行：生成密钥、添加只读 Deploy key、设置 secret、删除本地密钥
```
