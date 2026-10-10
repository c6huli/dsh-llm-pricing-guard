/**
 * Client half — 压缩进度条，渲染在 `conversation.input.dock`（输入框上方全宽槽）。
 *
 * 数据来自 Host 注册的 `compaction` 会话投影（index.js compactionProjection）：
 * api-session-controller 会把所有已注册 wire 键的基线与变更推送到本客户端，
 * 组件经标准注入的 useProjection('compaction') 订阅，无需自行折会话事件。
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-pricing-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'compaction-progress';

    const en = {
      'phase.command': 'Preparing compaction…',
      'phase.summarize': 'Compacting context…',
      'phase.commit': 'Writing summary…',
      'done': 'Compaction complete',
      'failed': 'Compaction failed',
      'bar.label': 'Compaction progress',
    };
    const zh = {
      'phase.command': '正在准备压缩…',
      'phase.summarize': '正在压缩上下文…',
      'phase.commit': '正在写入摘要…',
      'done': '压缩完成',
      'failed': '压缩失败',
      'bar.label': '压缩进度',
    };

    const CSS = `
.dlpg_root{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 2px 2px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dlpg_head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dlpg_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlpg_pct{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dlpg_track{position:relative;overflow:hidden;border-radius:var(--dsw-alias-radius-md,6px);
  background:var(--dsw-alias-bg-layer-2);height:4px}
.dlpg_fill{height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);
  transition:width 140ms linear}
.dlpg_fill[data-outcome="ok"]{background:var(--dsw-alias-state-success-primary)}
.dlpg_fill[data-outcome="fail"]{background:var(--dsw-alias-state-error-primary)}
.dlpg_root[data-outcome="fail"] .dlpg_label{color:var(--dsw-alias-state-error-primary)}
.dlpg_root[data-outcome="ok"] .dlpg_label{color:var(--dsw-alias-state-success-primary)}
`;

    /** 每阶段的进度上限（%）：命令期快速起步，摘要期封顶避免到 100% 后卡住，提交期接近完成。 */
    function capOf(phase) {
      if (phase === 'commit') return 97;
      if (phase === 'summarize') return 88;
      return 12;
    }

    function CompactionProgress({ useProjection, t }) {
      const view = useProjection('compaction');
      const active = view != null && view.active === true;
      const phase = view != null && typeof view.phase === 'string' ? view.phase : null;
      const failed = view != null && view.error === true;

      const [shown, setShown] = React.useState(false);
      const [percent, setPercent] = React.useState(0);
      const [outcome, setOutcome] = React.useState(null); // null | 'ok' | 'fail'
      const activeRef = React.useRef(false);
      const capRef = React.useRef(12);

      capRef.current = outcome !== null ? 100 : !active ? 100 : capOf(phase);

      // 生命周期：激活 → 显示；结束后置 100%，成功短暂展示、失败多留一会儿再隐藏。
      React.useEffect(() => {
        if (active) {
          if (!activeRef.current) {
            activeRef.current = true;
            setShown(true);
            setOutcome(null);
            setPercent(0);
          }
          return;
        }
        if (!activeRef.current) return;
        activeRef.current = false;
        const next = failed ? 'fail' : 'ok';
        setOutcome(next);
        setPercent(100);
        const id = setTimeout(() => {
          setShown(false);
          setOutcome(null);
          setPercent(0);
        }, failed ? 4000 : 1200);
        return () => clearTimeout(id);
      }, [active, failed]);

      // 缓动推进：朝当前阶段上限靠近，阶段切换时上限跳变即加速。
      React.useEffect(() => {
        if (!shown) return;
        const id = setInterval(() => {
          setPercent((p) => {
            const target = capRef.current;
            if (p >= target) return p;
            return Math.min(target, p + Math.max(0.6, (target - p) * 0.07));
          });
        }, 140);
        return () => clearInterval(id);
      }, [shown]);

      if (!shown) return null;

      const label = outcome === 'fail'
        ? t('failed')
        : outcome === 'ok'
          ? t('done')
          : t(`phase.${phase ?? 'command'}`);
      const value = Math.round(percent);

      return h('div', {
        className: 'dlpg_root',
        'data-outcome': outcome ?? undefined,
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': value,
        'aria-label': t('bar.label'),
      },
      h('style', null, CSS),
      h('div', { className: 'dlpg_head' },
        h('span', { className: 'dlpg_label' }, label),
        h('span', { className: 'dlpg_pct' }, `${value}%`)),
      h('div', {
        className: 'dlpg_track',
        role: 'presentation',
      }, h('div', {
        className: 'dlpg_fill',
        'data-outcome': outcome ?? undefined,
        style: { width: `${value}%` },
      })));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-pricing-guard: dictionaries');
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'compaction-progress',
          order: 30,
          locale: NS,
        }, CompactionProgress));
      },
    };
  },
});
