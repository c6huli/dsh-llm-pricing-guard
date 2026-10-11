# dsh-llm-pricing-guard

DSH 插件：修复 `/compact` 崩溃，并增加**上下文压缩进度条**。

> DSH plugin that fixes `/compact` crashes and adds a **live compaction progress bar** above the composer.

## 功能 / Features

### 1. imageRequestPricing 调用点守卫

DSH 0.1.2-rc.1 为适配器新增了 `imageRequestPricing` 接缝，但 `LlmRuntime.imageRequestPricing` 内部是：

```js
this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)
```

可选链只保护"适配器不存在"，不保护"适配器存在但未实现该方法"。第三方鸭子类型适配器缺少该方法时直接抛 `TypeError`，导致：

```
command.execute failed: gateway/internal: this.adapters.get(...)?.adapter.imageRequestPricing is not a function
```

本插件在已注册 `llm` 服务实例的原型链上安装守卫：

| 场景 | 行为 |
|---|---|
| 适配器未注册 | 原实现语义不变（返回 `undefined`） |
| 适配器已实现该方法 | 原样委托原实现 |
| 适配器已注册但缺方法 | 降级返回 `undefined`，不再抛错 |
| 其余路径（内部其它错误） | 完全透传原实现，错误语义不变 |

### 2. 压缩进度条

在输入框上方（`conversation.input.dock` 槽）渲染实时进度条，数据来自 Host 侧注册的 `compaction` 会话投影：

- 生命周期：`command/run 'compact'` → `compaction/start` → `compaction/summary` → `compaction/end`
- 阶段文案：正在准备压缩… → 正在压缩上下文… → 正在写入摘要… → 压缩完成 / 压缩失败
- 进度按阶段缓动推进（12% → 88% → 97% → 100%），结束后短暂展示再淡出
- 自动压缩（turn 内触发、无命令事件）同样覆盖

## 安装 / Install

```bash
dsh plugin --profile <你的profile> add dsh-llm-pricing-guard
```

或在 DSH Web UI 的 **Plugins** 页面粘贴包名安装。安装后重启 `dsh web` 并刷新页面（Client 模块需要重新加载）。

> 安装后执行 `/compact` 验收：应看到进度条按阶段推进，且不再出现 `gateway/internal` 错误。

## 已知边界 / Known limitations

- 若会话在 `compaction/start` 后崩溃留下未配对的 start，日志重放后进度条会停在摘要阶段——该会话本身已被压缩锁阻塞，属日志真实状态。
- `dsh-session-persistence-jsonl` 的 worker 线程内含独立打包的 LlmRuntime 副本，Host 插件触及不到；但 `/compact` 的失败路径在 Host 主线程，已被守卫覆盖。
- 若上游 DSH 修复了该调用点，守卫会自动变成无害的空操作，可直接卸载本插件。

## 开发 / Development

```
index.js       Host 半：imageRequestPricing 守卫 + compaction 会话投影
client.js      Client 半：进度条组件（conversation.input.dock 槽）
cordis.patch.yml  bundle patch
locale/        插件管理器显示元数据（en/zh）
test/          投影状态机与守卫的单元测试
```

```bash
npm test   # node --test（自动发现 test/*.test.mjs）
```

## 上架 / Publishing

```bash
npm publish          # 发布到 npm 官方源（publishConfig.access=public）
git remote add origin https://github.com/c6huli/dsh-llm-pricing-guard.git
git push -u origin main
```

## License

[MIT](./LICENSE)

注：在0.2.0-rc.2完全确认有效
