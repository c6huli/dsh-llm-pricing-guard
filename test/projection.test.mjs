import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactionProjection, installGuard } from '../index.js';

const P = compactionProjection;

function step(state, type, data) {
  return P.apply(state, { type, data: data ?? {} });
}

test('无关事件保持同引用', () => {
  const s = P.init();
  assert.equal(P.apply(s, { type: 'user/message', data: {} }), s);
  assert.equal(P.wire.view(s).active, false);
});

test('手动 /compact 成功路径', () => {
  let s = P.init();
  s = step(s, 'command/run', { name: 'compact', commandId: 'c1' });
  assert.equal(P.wire.view(s).active, true);
  assert.equal(P.wire.view(s).phase, 'command');
  s = step(s, 'compaction/start', { compactionId: 'k1', turn: null });
  assert.equal(P.wire.view(s).phase, 'summarize');
  s = step(s, 'compaction/summary', { compactionId: 'k1', shadowedTokenCount: 10 });
  assert.equal(P.wire.view(s).phase, 'commit');
  s = step(s, 'compaction/end', { compactionId: 'k1', turn: null });
  assert.equal(P.wire.view(s).active, false);
  assert.equal(P.wire.view(s).error, false);
  s = step(s, 'command/done', { commandId: 'c1', kind: 'success' });
  assert.equal(P.wire.view(s).active, false);
});

test('命令失败但未启动 compaction（busy/无历史）以命令结果收尾', () => {
  let s = P.init();
  s = step(s, 'command/run', { name: 'compact', commandId: 'c2' });
  s = step(s, 'command/done', { commandId: 'c2', kind: 'error' });
  assert.equal(P.wire.view(s).active, false);
  assert.equal(P.wire.view(s).error, true);
});

test('自动压缩（无命令事件）且 end 带 error', () => {
  let s = P.init();
  s = step(s, 'compaction/start', { compactionId: 'k2', turn: 7 });
  assert.equal(P.wire.view(s).active, true);
  assert.equal(P.wire.view(s).phase, 'summarize');
  s = step(s, 'compaction/end', { compactionId: 'k2', turn: 7, error: 'boom' });
  assert.equal(P.wire.view(s).active, false);
  assert.equal(P.wire.view(s).error, true);
});

test('其它命令的 done 不影响进行中的压缩', () => {
  let s = P.init();
  s = step(s, 'command/run', { name: 'compact', commandId: 'c3' });
  s = step(s, 'compaction/start', { compactionId: 'k3', turn: null });
  s = step(s, 'command/done', { commandId: 'other', kind: 'error' });
  assert.equal(P.wire.view(s).active, true);
  assert.equal(P.wire.view(s).phase, 'summarize');
});

test('schema 拒绝非法状态、接受合法状态', () => {
  P.stateSchema.parse(P.init());
  P.wire.viewSchema.parse(P.wire.view(P.init()));
  assert.throws(() => P.stateSchema.parse(null));
  assert.throws(() => P.wire.viewSchema.parse(null));
});

test('未配对 start 的崩溃会话重放为 active（已记录的边界）', () => {
  let s = P.init();
  s = step(s, 'command/run', { name: 'compact', commandId: 'c4' });
  s = step(s, 'compaction/start', { compactionId: 'k4', turn: null });
  assert.equal(P.wire.view(s).active, true);
  assert.equal(P.wire.view(s).phase, 'summarize');
});

class FakeRuntime {
  adapters = new Map();
  imageRequestPricing(provider, model) {
    return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
  }
}

test('守卫：鸭子类型适配器缺方法时降级，实现方原样委托', () => {
  const rt = new FakeRuntime();
  rt.adapters.set('duck', { adapter: { providerInfo: () => ({ id: 'duck' }) } });
  rt.adapters.set('real', { adapter: { imageRequestPricing: (p, m) => ({ provider: p, model: m }) } });
  assert.throws(() => rt.imageRequestPricing('duck', 'x'), TypeError);

  const restore = installGuard(rt);
  assert.equal(typeof restore, 'function');
  assert.equal(rt.imageRequestPricing('duck', 'x'), undefined);
  assert.deepEqual(rt.imageRequestPricing('real', 'm1'), { provider: 'real', model: 'm1' });
  assert.equal(rt.imageRequestPricing('nope', 'm'), undefined);
  assert.equal(installGuard(rt), undefined); // 幂等

  restore();
  assert.throws(() => rt.imageRequestPricing('duck', 'x'), TypeError);
});
