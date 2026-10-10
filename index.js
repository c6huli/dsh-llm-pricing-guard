/**
 * llm-pricing-guard — 修复 /compact 在 imageRequestPricing 调用点的 TypeError。
 *
 * DSH 0.2.0-rc.2 的 LlmRuntime.imageRequestPricing 内部为：
 *   this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
 * 可选链只保护“适配器不存在”，不保护“适配器存在但未实现该方法”。
 * 鸭子类型注册的第三方适配器缺少该方法时直接抛 TypeError，
 * 使 tokenMeter.measure() 在压缩上下文时崩溃（command.execute failed: gateway/internal）。
 *
 * 本插件在已注册 llm 服务实例的原型链上，定位 imageRequestPricing 的
 * 所有者对象，把该方法替换为带 typeof 存在性检查的守卫版本：
 *   - 适配器未注册            → 原实现语义不变（返回 undefined）
 *   - 适配器已注册且实现方法    → 原样委托给原实现
 *   - 适配器已注册但缺方法      → 降级返回 undefined（不再抛 TypeError）
 * 其余路径（this 丢失、内部其它错误）完全透传原实现，错误语义不变。
 */

const MARK = Symbol.for('dsh.llm-pricing-guard.patched');

/** 沿原型链找到 own 定义 name 的对象；找不到返回 undefined。 */
function ownerOf(object, name) {
  let cursor = object;
  while (cursor && !Object.prototype.hasOwnProperty.call(cursor, name)) {
    cursor = Object.getPrototypeOf(cursor);
  }
  return cursor;
}

/**
 * 为一个 llm 运行时实例打补丁。幂等：同一 owner 重复安装直接跳过。
 * @returns {(() => void) | undefined} 还原函数；无需安装时返回 undefined。
 */
export function installGuard(llm) {
  if (!llm || typeof llm !== 'object') return undefined;
  const owner = ownerOf(llm, 'imageRequestPricing');
  if (!owner || typeof owner.imageRequestPricing !== 'function') return undefined;
  if (owner[MARK]) return undefined;

  const original = owner.imageRequestPricing;

  function guarded(provider, model) {
    let adapter;
    try {
      adapter = this && this.adapters instanceof Map
        ? this.adapters.get(provider)?.adapter
        : undefined;
    } catch {
      adapter = undefined;
    }
    if (adapter != null && typeof adapter.imageRequestPricing !== 'function') {
      // 适配器已注册但未实现 0.1.2-rc.1 新增的接缝：按“未声明计价”降级。
      return undefined;
    }
    return original.call(this, provider, model);
  }
  guarded[MARK] = true;

  Object.defineProperty(owner, 'imageRequestPricing', {
    value: guarded,
    writable: true,
    configurable: true,
  });
  // 幂等标记打在 owner 上：owner[MARK] 为真即表示已安装守卫。
  Object.defineProperty(owner, MARK, {
    value: true,
    writable: true,
    configurable: true,
  });

  return () => {
    if (owner.imageRequestPricing === guarded) {
      owner.imageRequestPricing = original;
      delete owner[MARK];
    }
  };
}

export const inject = ['llm'];

/**
 * 手写 schema：本包解析不到 zod（工作区与 profile 均 ERR_MODULE_NOT_FOUND），
 * 而 sessionProjections 注册表/检查点缓存只调用 schema.parse()。
 */
const schema = (name, check) => ({
  parse(value) {
    if (!check(value)) throw new Error(`compaction projection: invalid ${name}`);
    return value;
  },
});

/**
 * 压缩进度投影：从会话日志折出 /compact 生命周期，经 wire 推送给 Client。
 * 事件形状已对照 dsh-commands（command/run/done）与 dsh-compaction（start/summary/end）。
 */
export const compactionProjection = {
  key: 'compaction',
  stateVersion: 1,
  stateSchema: schema('state', (v) =>
    v !== null && typeof v === 'object' &&
    typeof v.active === 'boolean' &&
    (v.phase === null || typeof v === 'object')),
  init: () => ({ active: false, phase: null, error: false, compactionId: null, running: null }),
  apply: (state, event) => {
    const data = event.data;
    if (event.type === 'command/run') {
      // 只认 /compact 人机命令；已激活时不重复进入（自动压缩无此事件）。
      if (data.name !== 'compact' || state.active) return state;
      return {
        ...state, active: true, phase: 'command', error: false,
        compactionId: null, running: data.commandId ?? null,
      };
    }
    if (event.type === 'command/done') {
      if (state.running === null || data.commandId !== state.running) return state;
      // 命令已收尾却未启动 compaction（busy/无历史/参数错误）：以命令结果关闭。
      if (state.active && state.compactionId === null) {
        return {
          ...state, active: false, phase: null,
          error: data.kind !== 'success', running: null,
        };
      }
      return { ...state, running: null };
    }
    if (event.type === 'compaction/start') {
      // 自动压缩（turn 内）与手动 /compact 共用同一对事件。
      return {
        ...state, active: true, phase: 'summarize', error: false,
        compactionId: data.compactionId, running: state.running,
      };
    }
    if (event.type === 'compaction/summary') {
      if (!state.active || data.compactionId !== state.compactionId) return state;
      return { ...state, phase: 'commit' };
    }
    if (event.type === 'compaction/end') {
      if (!state.active || data.compactionId !== state.compactionId) return state;
      return {
        ...state, active: false, phase: null,
        error: data.error !== undefined, running: null,
      };
    }
    return state; // 无关事件返回同引用，注册表跳过 view 计算
  },
  wire: {
    viewSchema: schema('view', (v) =>
      v !== null && typeof v === 'object' && typeof v.active === 'boolean'),
    view: (state) => ({
      active: state.active,
      phase: state.phase,
      error: state.error,
      compactionId: state.compactionId,
    }),
  },
};

export function apply(ctx) {
  const restores = [];
  let installedLog = false;

  const install = () => {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
    const restore = installGuard(llm);
    if (!restore) return;
    restores.push(restore);
    if (!installedLog) {
      installedLog = true;
      ctx.logger.info('llm-pricing-guard: imageRequestPricing 调用点已加方法存在性防御');
    }
  };

  install();
  // dsh-llm 热重载或适配器拓扑变化后重打补丁（幂等）。
  ctx.on('hmr/reload', install);
  ctx.on('llm/adapters-updated', install);

  // 压缩进度投影：sessionProjections 缺失时该子 fiber 挂起，不影响守卫。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(compactionProjection);
  });

  ctx.effect(() => () => {
    for (const restore of restores.splice(0).reverse()) restore();
  });
}
