/* global document, window, URL */

window.__ModuleLoader__.load({
  id: '@allrice/dsh-runtime-diff',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs } = require('react/jsx-runtime');

    let catalog = null;
    try {
      const meta = document.querySelector(
        'meta[name="allrice-dsh-capabilities"]',
      );
      if (meta) catalog = JSON.parse(decodeURIComponent(meta.content));
    } catch {
      // Keep the existing comparison usable if an older gateway served the page.
    }
    const consoleUrl = window.location.hostname.startsWith('dsh.')
      ? new URL('/runtime-console?view=employees', window.location.href)
      : null;
    if (consoleUrl) consoleUrl.hostname = `allrice-${window.location.hostname}`;

    const styleId = '@allrice/dsh-runtime-diff/styles';
    if (!document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
      const style = document.createElement('style');
      style.dataset.plugin = '@allrice/dsh-runtime-diff';
      style.dataset.pluginCss = styleId;
      style.textContent = `
.allriceRuntimeDiff{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-family:inherit}
.allriceRuntimeDiff *{box-sizing:border-box}
.allriceRuntimeDiff__header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:18px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.allriceRuntimeDiff__header h2{margin:0 0 8px;font-size:20px;line-height:28px}
.allriceRuntimeDiff__header p{max-width:560px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.allriceRuntimeDiff__readonly{flex:none;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.allriceRuntimeDiff__summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.allriceRuntimeDiff__summary div{padding:13px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.allriceRuntimeDiff__summary strong{display:block;margin-bottom:3px;font-size:18px;line-height:24px}
.allriceRuntimeDiff__summary span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.allriceRuntimeDiff__group{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.allriceRuntimeDiff__groupHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.allriceRuntimeDiff__groupHeader h3{margin:0;font-size:15px;line-height:22px}
.allriceRuntimeDiff__tag{flex:none;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.allriceRuntimeDiff__list{display:grid;margin:0;padding:4px 16px;list-style:none}
.allriceRuntimeDiff__item{display:grid;grid-template-columns:minmax(150px,0.8fr) minmax(220px,1.4fr);gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.allriceRuntimeDiff__item:last-child{border-bottom:0}
.allriceRuntimeDiff__item strong{font-size:13px;line-height:20px}
.allriceRuntimeDiff__item span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.allriceRuntimeDiff__upgrade{display:grid;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.allriceRuntimeDiff__upgrade h3,.allriceRuntimeDiff__upgrade p{margin:0}
.allriceRuntimeDiff__upgrade p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.allriceRuntimeDiff a{color:var(--dsw-alias-label-primary);text-decoration:underline}
.allriceRuntimeDiff__footer{padding:14px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
@media(max-width:720px){.allriceRuntimeDiff__summary{grid-template-columns:1fr}.allriceRuntimeDiff__item{grid-template-columns:1fr;gap:2px}}
`;
      document.head.appendChild(style);
    }

    const shared = [
      ['Agent Loop', 'DSH Agent Spine 与模型工具循环'],
      ['Provider 与凭证', 'Codex OAuth、模型路由和平台凭证文档'],
      ['Session', '多轮会话、JSONL 持久化与检查点策略'],
      ['上下文治理', 'Token 计量、压缩与恢复基础能力'],
    ];
    const adminOnly = [
      ['官方 WebUI', '设置、模型、插件清单与 Agent 预设界面'],
      ['完整插件目录', '完整候选插件及其启用、停用和配置状态'],
      ['原生主机工具', 'Shell、终端、文件系统、浏览器与工作流实验能力'],
      ['工程调试环境', '独立 DSH_HOME、原生 Session 与插件实验配置'],
    ];
    const runtimeOnly = [
      ['ChatFlow 3.0', '多租户 Session、Run、事件流与 Harness 路由'],
      ['AllRice Tool Broker', '冻结能力快照、权限校验、审批与执行审计'],
      [
        'Rice Bridge',
        'local.fs.* 授权目录受控读写与 local.git.* 本地只读 Native Tools',
      ],
      ['开发协作', '编辑提案、同版沙箱测试、独立审查与正式交付'],
      ['员工能力装配', '按员工分配 Skill、Workflow、Knowledge 与模型策略'],
    ];

    function Group({ title, tag, items }) {
      return jsxs('section', {
        className: 'allriceRuntimeDiff__group',
        children: [
          jsxs('div', {
            className: 'allriceRuntimeDiff__groupHeader',
            children: [
              jsx('h3', { children: title }),
              jsx('span', {
                className: 'allriceRuntimeDiff__tag',
                children: tag,
              }),
            ],
          }),
          jsx('ul', {
            className: 'allriceRuntimeDiff__list',
            children: items.map(([name, detail]) =>
              jsxs(
                'li',
                {
                  className: 'allriceRuntimeDiff__item',
                  children: [
                    jsx('strong', { children: name }),
                    jsx('span', { children: detail }),
                  ],
                },
                name,
              ),
            ),
          }),
        ],
      });
    }

    function UpgradeCapabilities() {
      if (!catalog)
        return jsx('p', {
          children: '版本与升级能力信息暂不可用，请刷新页面。',
        });
      return jsxs('section', {
        className: 'allriceRuntimeDiff__upgrade',
        children: [
          jsx('h3', { children: `当前构建 · DSH ${catalog.version}` }),
          jsx('p', {
            children:
              '升级能力默认展示。已接入的能力可前往 AllRice 配置试用，原生能力可在 Lab 中探索。',
          }),
          catalog.reviewedVersion !== catalog.version
            ? jsx('p', {
                children: `能力说明复核于 ${catalog.reviewedVersion}，当前版本说明待同步。`,
              })
            : null,
          consoleUrl
            ? jsx('a', {
                href: consoleUrl.toString(),
                target: '_blank',
                rel: 'noreferrer',
                children: '前往 AllRice 配置 Rice 并试用 →',
              })
            : null,
          ...catalog.groups.map((group) =>
            jsxs(
              'section',
              {
                children: [
                  jsx('h3', { children: group.title }),
                  jsx('p', { children: group.description }),
                  jsx('ul', {
                    className: 'allriceRuntimeDiff__list',
                    children: group.items.map((item) =>
                      jsxs(
                        'li',
                        {
                          className: 'allriceRuntimeDiff__item',
                          children: [
                            jsx('strong', { children: item.name }),
                            jsx('span', {
                              children: `${item.status} · ${item.detail}`,
                            }),
                          ],
                        },
                        item.id,
                      ),
                    ),
                  }),
                ],
              },
              group.id,
            ),
          ),
          jsx('a', {
            href: 'https://github.com/semiok/allrice/blob/main/docs/architecture/dsh-reuse-and-replacement.md',
            target: '_blank',
            rel: 'noreferrer',
            children: '查看复用清单与接入进度 →',
          }),
        ],
      });
    }

    function RuntimeDiffSection() {
      return jsxs('div', {
        className: 'allriceRuntimeDiff',
        children: [
          jsxs('header', {
            className: 'allriceRuntimeDiff__header',
            children: [
              jsxs('div', {
                children: [
                  jsx('h2', { children: 'DSH 版本与能力' }),
                  jsx('p', {
                    children:
                      '查看当前升级能力与 AllRice 接入情况，快速找到可以试用和复用的功能。',
                  }),
                ],
              }),
              jsx('span', {
                className: 'allriceRuntimeDiff__readonly',
                children: '能力总览',
              }),
            ],
          }),
          jsx(UpgradeCapabilities, {}),
          jsxs('div', {
            className: 'allriceRuntimeDiff__summary',
            children: [
              jsxs('div', {
                children: [
                  jsx('strong', { children: '共有' }),
                  jsx('span', { children: '两边均启用的 DSH 基建' }),
                ],
              }),
              jsxs('div', {
                children: [
                  jsx('strong', { children: 'DSH 管理独有' }),
                  jsx('span', { children: '完整 Web Profile 与候选插件' }),
                ],
              }),
              jsxs('div', {
                children: [
                  jsx('strong', { children: 'AllRice 独有' }),
                  jsx('span', { children: 'SaaS 治理与本地 Bridge 能力' }),
                ],
              }),
            ],
          }),
          jsx(Group, { title: '共有能力', tag: '已共享', items: shared }),
          jsx(Group, {
            title: '仅 DSH 管理实例',
            tag: 'Lab 探索',
            items: adminOnly,
          }),
          jsx(Group, {
            title: '仅 AllRice Runtime',
            tag: 'AllRice 托管',
            items: runtimeOnly,
          }),
          jsx('div', {
            className: 'allriceRuntimeDiff__footer',
            children:
              '已接入的能力通过 AllRice 员工配置试用并发布；原生能力的实验结果进入复用清单，随后续版本持续接入。',
          }),
        ],
      });
    }

    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'allrice-runtime-diff',
            order: 40,
            label: () => '版本与能力',
          },
          RuntimeDiffSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
