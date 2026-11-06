// 服务端判定的假实现（PRD-chat F-ACC-03 规则 4）：对照 server/e2e/accountmodel/server.go，protocol/vectors/account-session.json 的
// serverCases 约束它（account-vectors.test.ts），然后 SDK 的端到端场景用它当假服务端。只有代号和时间，没有签名。
export type RefreshResult =
  'issued' | 'issuedPromoted' | 'superseded' | 'replayDetected' | 'alreadyRevoked' | 'rateLimited';
export type AccessResult = 'ok' | 'promoted' | 'tokenExpired' | 'sessionRevoked';

export class FakeAccountSession {
  current = 1;
  next = 2;
  overlapUntil = 0;
  overlapMinGen = 0;
  pendings: number[] = [];
  revoked = false;
  issued = 0;
  now = 0;
  private readonly maxPending = 4;
  private readonly issueRate = 20;
  private readonly overlapMs = 120_000;

  private promote(gen: number): void {
    this.overlapUntil = this.now + this.overlapMs;
    this.overlapMinGen = this.current;
    this.current = gen;
    this.pendings = [];
  }

  refresh(gen: number): { result: RefreshResult; newGen?: number } {
    if (this.revoked) return { result: 'alreadyRevoked' };
    const pending = this.pendings.includes(gen);
    if (gen !== this.current && !pending) {
      if (gen >= this.overlapMinGen && this.now < this.overlapUntil) return { result: 'superseded' };
      this.revoked = true;
      return { result: 'replayDetected' };
    }
    if (this.issued >= this.issueRate) return { result: 'rateLimited' };
    this.issued += 1;
    let result: RefreshResult = 'issued';
    if (pending) {
      this.promote(gen);
      result = 'issuedPromoted';
    }
    const newGen = this.next++;
    this.pendings.push(newGen);
    if (this.pendings.length > this.maxPending) this.pendings = this.pendings.slice(-this.maxPending);
    return { result, newGen };
  }

  access(gen: number): AccessResult {
    if (this.revoked) return 'sessionRevoked';
    if (gen === this.current) return 'ok';
    if (this.pendings.includes(gen)) {
      this.promote(gen);
      return 'promoted';
    }
    return 'tokenExpired';
  }
}
