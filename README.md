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
im.muteState(convId);            // null，或 { scope: 'user' | 'group' | 'groupAll', groupId?, mutedUntil }（永久为 null；全群禁言不限制群主、管理员）
im.on('muteChanged', () => …);   // muted / unmuted、auth ack、convs、发送返回 4031、到期（按服务端时间）
im.debugExport();                // 调试：内存里的会话和全部消息副本（拷贝，不含 token）
```

重连后 SDK 会重新拉一遍已加载的 seq 范围：断开期间被删除的消息不会再发 `msgDeleted`，只有 `sync` 能拿到。

## 系统推送（PRD-live v1.0 第 4 节）

```ts
const off = im.on('push', (p) => {
  // { pushId, type, data, ts, target, roomId?, pushSeq?, replayed }，按 type 分发由业务负责
});
im.on('pushSynced', ({ latestSeq }) => …); // 一轮补拉结束，可选
new IMClient({ url, pushStart: 'latest' }); // 没有游标时只建立游标、不回放（灰度用），默认 'beginning'
```

- **只有 `push` 的监听器才算订阅者**：没有订阅者时不发 `pushSync`，带 `pushSeq` 的实时帧丢弃，之后从收件箱补回；不带 `pushSeq` 的（全员、按房间、`ttlSeconds=0`）进上限 500 的队列，溢出丢最旧。
- 第一个订阅者到下一个微任务才生效：先交付队列，再补拉；同一微任务内注册的都能收到积压。
- 带 `pushSeq` 的至少一次，业务按 `pushId` 幂等处理；不带的至多一次。业务回调抛异常不影响 SDK。
- `replayed = ts < T0`，`T0` 是本实例上该账号第一次 `auth` 的 `serverTime`，重连不变：闪断期间的是 `false`，刷新后补到的旧推送是 `true`。
- 没有持久化：游标只在内存，新实例和换账号都从 `afterSeq: 0` 开始。服务端未开启（4001）时静默，这次连接内不再发。
- SDK 不把 `data` 写进日志。行为判据是 `protocol/vectors/push-sync.json`（`test/push-vectors.test.ts`，`persistence=true` 的用例跳过）。

## 账号（PRD-chat C1）

账号接口是 HTTP，独立于 `IMClient`。token 来源 HTTP 和 WS 共用（语义和 Kotlin、Swift 的对照基准见 tianting-server 的 `docs/sdk/README.md` 第 6 节）。

```ts
const account = new AccountClient({ baseUrl: 'https://im.example.com', platform: 'web', store });
account.on('ended', (e) => …);                 // 回登录页。提示文字：sessionDialogText(e)
account.on('recoveryCodeUnacked', () => …);    // 强制进保存恢复码页

const { recoveryCode, recoveryCodeGen } = await account.login(username, password); // register、recover 同样
await account.ackRecoveryCode(recoveryCodeGen!); // 确认之前 token 只放内存，确认后才写 store

im.connect(account.tokenProvider);             // 账号模式：自动刷新、换 token 重连、4011 比较代号
im.connect(token);                             // 演示模式：行为不变
im.on('fatal', (r) => …);                      // kicked 带 recoverBefore；{kind:'session'} 是刷新得到 4019 等
im.on('securityNotice', (n) => …);

await account.start();                         // 启动：读 store，检查是否要刷新
account.foreground();                          // 回到前台
await account.changePassword(oldPw, newPw);    // 进行中缓存踢线，成功换新 sid 重连
await account.logoutOthers(pw); await account.logout();
await account.regenerateRecoveryCode(pw); await account.updateProfile({ nickname });
await account.getConfig(); await account.listEvents();
await account.requestDelete(pw); await account.cancelDelete(username, pw);
```

错误：`AccountError`（`status`、`code`、`reason`、`details`）、`AccountNetworkError`、`AccountTimeoutError`（30 秒，迟到的响应被丢弃）、`SessionEndedError`。
测试替身：`@tianting/sdk/testing` 的 `FakeHttp`，配合 `FakeTransport`、`FakeClock`。

## 图片和文件（PRD-chat C2）

```ts
const files = new FileClient({ auth: account, upload: new XhrUploadTransport() }); // 演示模式：new StaticTokenAuth(baseUrl, token)
const im = new IMClient({ url, files });
// 图片处理（压缩、缩略图 ≤ 480、去 EXIF）在 App 里做；可以传处理好的结果，也可以传一个函数，轮到它时才调用（并发 1）
const m = im.sendImage(convId, () => processInCanvas(file), { onProgress: (sent, total) => …, signal });
im.sendFile(convId, { data: file, name: file.name, mime: file.type });
im.cancelUpload(convId, m.clientMsgId);         // 中止上传、发 DELETE、消息消失；已经在 send 的不能取消
im.retry(convId, clientMsgId);                  // 已 complete 的复用 fileId；没传完的从头传；没有源时 error = 'sourceMissing'
const [r] = await im.getFileUrls([{ fileId, variant: 'thumb' }]); // 同一事件循环内合并成一批（≤ 50），没到期的地址用缓存
im.on('filesExpired', (fileIds) => …);         // 过期或被删：清掉 App 按 fileId + variant 缓存的图片
```

状态：`processing` → `uploading` → `queued`（待发送，已 complete）→ `sending` → `sent`，任何一步可以 `failed`。
`error`：错误码（4292 额度用完、4290 + `errorReason: 'uploadPendingLimit'`、4139、4150、4096、5032），或 `network`、`process`、`timeout`、`kicked`、`sourceMissing`。
4292、`uploadPendingLimit` 不自动重试；`complete` 的 5032 退避重试 3 次；`send` 返回 4096 时有源的回到上传中重新上传；返回 4048 时，只有这台设备自己上传（`complete` 成功）的 `fileId` 同样处理，别人的 `fileId`（转发等）照常失败（PRD-chat v1.4 F-FILE-07 规则 4）。
源（File / Blob）只在内存里，发出后释放，刷新就没有了。预签名地址和文件名不进日志。
重连时只重拉 `modVer` 变了的会话（服务端没有 `modVer` 时全部重拉）；`deleted`、`expired` 只能从假变真。

## 撤回、引用、提及（PRD-chat C4）

```ts
await im.recall(convId, msgId);                 // 成功后本地立即变撤回；失败抛 IMError，不自动重试
im.canRecall(message);                          // 按 ts 和 auth ack 校正后的服务端时间：自己的 2 分钟；群主、管理员 7 天
im.messageActions(message);                     // ['copy', 'quote', 'recall'] 的子集；撤回、删除的消息和提示行是 []
im.recallText(convId, messageOrLastMsg);        // F-RCL-02 规则 1a 的文案（聊天页和列表摘要同一张表）；不是撤回的为 null
im.send(convId, text, { quote: { msgId }, mentions: { userIds, all } }); // mentions 只在群聊（单聊直接抛错）
await im.searchGroupMembers(groupId, keyword);  // @ 选人：userId 或昵称前缀
quoteLabel(message.body.quote);                 // "引用内容已被撤回"等四种状态的文字，页面按纯文本渲染
messageFor('recall', 4097, { windowSeconds });  // "发送时间超过 2 分钟，无法撤回"；4030 "你没有权限撤回这条消息"；send 4293 "@所有人次数已用完"
```

撤回复用 `msgDeleted`：消息和 `lastMsg` 同时 `deleted`、`recalled`，带 `recalledBy`；原文、文件名、本地所有引用它的 `quote.text` 都清掉，文件通过 `filesExpired` 通知。
`deleted`、`recalled` 只能从假变真，`quote.state` 只能从 `normal` 往后走，迟到的旧应答不回写。
`Conversation.mentionUnread`、`firstMentionSeq` 来自 `convs`；实时收到 @ 我的消息本地加 1，在这个会话读到最新后清零；
有提及时收到 `readUpdated`、`msgDeleted` 重新拉 `convs`，5 秒内最多一次。4040（`errorReason: 'quoteUnavailable'`）、4293、4131 标记失败，不自动重发。
引用文字、@ 的内容不进日志。

## 置顶、免打扰、删除会话（PRD-chat C5）

```ts
await im.setConvPinned(convId, true);           // 乐观更新：先移到最前；ack 的 conv 覆盖本地；失败回滚并抛 IMError，不自动重试
await im.setConvNotifyOff(convId, true);        // 同上（4220 置顶已满、4290、4030、5000、超时都回滚）
await im.deleteConv(convId);                    // upToSeq = 本地看到的最大 seq；先从列表消失，失败恢复；页面先弹确认框
im.totalUnread();                               // 普通会话的 unread 之和 + 免打扰会话的 mentionUnread 之和
im.on('convDeleted', (convId) => …);            // 本端删除成功或其他设备删除了它：页面清这个会话的草稿
```

`Conversation` 增加 `pinned`、`pinnedAt`、`notifyOff`（没有时不带，按 false）；`conversations()` 置顶的在前（`pinnedAt` 倒序），
其余 `updatedAt` 倒序，同时间按 `convId`。其他设备改的设置由 `convSettingsChanged` 覆盖本地。
删除：`minSeq = clearedSeq + 1`、已读推进到 `clearedSeq`、不再置顶、保留免打扰；`seq < minSeq` 的消息从内存清除（文件经 `filesExpired`），
迟到的应答不写回；本端删除时这个会话没发出的附件取消上传、排队和失败的消息丢弃。之后有新消息会话重新出现，未读只算新消息。
`convs` 的 `deleted` 里的群不是"你已不在该群"（没有 `convRemoved`、没有快照）；`truncated` 或 `deletedTruncated` 时不推断。
`features.convSettings` 关闭时只隐藏入口，SDK 照常应用已有的设置。

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

集成测试会编译并启动真实的服务端，需要 Go 1.27+ 和 tianting-server 的源码；文件用例另外启动 `test/integration/fake_s3.py`（标准库 Python 3，只监听 127.0.0.1，不验签名，只验调度逻辑）：

```bash
npm run test:integration       # 默认找同级目录 ../tianting-server/server
TIANTING_SERVER_DIR=/path/to/tianting-server/server npm run test:integration
```

CI 里的集成测试需要读取私有仓库 tianting-server：在 tianting-server 添加一个**只读**部署密钥（Deploy key），把私钥存为本仓库的 Actions secret `TIANTING_SERVER_DEPLOY_KEY`。没配置时 CI 跳过集成测试，只跑单元测试。

```bash
scripts/setup-ci-deploy-key.sh   # 由仓库所有者本人运行：生成密钥、添加只读 Deploy key、设置 secret、删除本地密钥
```
