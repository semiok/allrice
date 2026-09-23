/* global document, window, URL, fetch, AbortController */

window.__ModuleLoader__.load({
  id: '@allrice/dsh-runtime-diff',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const { jsx, jsxs } = require('react/jsx-runtime');
    const { useEffect, useState } = require('react');

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
.allriceRuntimeDiff__live{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.allriceRuntimeDiff__live section{min-width:0}
.allriceRuntimeDiff__live strong,.allriceRuntimeDiff__item span{overflow-wrap:anywhere}
.allriceRuntimeDiff details{font-size:12px;line-height:20px}
.allriceRuntimeDiff summary{cursor:pointer}
.allriceRuntimeDiff__footer{padding:14px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
@media(max-width:720px){.allriceRuntimeDiff__live{grid-template-columns:1fr}.allriceRuntimeDiff__summary{grid-template-columns:1fr}.allriceRuntimeDiff__item{grid-template-columns:1fr;gap:2px}}
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

    function useRuntimeStatus() {
      const [status, setStatus] = useState(null);
      useEffect(() => {
        let stopped = false,
          timer,
          controller;
        const refresh = async () => {
          controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 7000);
          try {
            const response = await fetch('/api/allrice/capabilities', {
              credentials: 'same-origin',
              cache: 'no-store',
              redirect: 'error',
              signal: controller.signal,
            });
            if (!response.ok) throw new Error('Unavailable');
            const result = await response.json();
            if (!stopped) setStatus(result);
          } catch {
            if (!stopped) setStatus(null);
          } finally {
            window.clearTimeout(timeout);
            if (!stopped) timer = window.setTimeout(refresh, 10000);
          }
        };
        void refresh();
        return () => {
          stopped = true;
          controller?.abort();
          window.clearTimeout(timer);
        };
      }, []);
      return status;
    }

    const stateLabels = {
      active: '运行中',
      disabled: '已停用',
      pending: '等待加载',
      failed: '加载失败',
      unknown: '状态未知',
    };
    const time = (value) => new Date(value).toLocaleTimeString();
    function LiveStatus({ status }) {
      const native = status?.native,
        allrice = status?.allrice?.data;
      const counts = native
        ? Object.keys(stateLabels)
            .map(
              (state) =>
                `${native.components.filter((c) => c.state === state).length} ${stateLabels[state]}`,
            )
            .join(' · ')
        : '插件状态未知';
      const summaryUrl = consoleUrl ? new URL(consoleUrl) : null;
      if (summaryUrl) summaryUrl.searchParams.set('view', 'capabilities');
      return jsxs('div', {
        className: 'allriceRuntimeDiff__live',
        children: [
          jsxs('section', {
            className: 'allriceRuntimeDiff__upgrade',
            'aria-label': 'DSH 实际运行状态',
            children: [
              jsx('h3', { children: 'DSH 实际运行状态' }),
              jsx('strong', {
                children: native
                  ? `DSH ${native.version ?? '版本未知'} · 已连接`
                  : '运行状态未知',
              }),
              jsx('p', { children: counts }),
              jsx('p', {
                children: native
                  ? `来自当前 DSH 进程 · 更新于 ${time(native.observedAt)}`
                  : '尚未收到有效运行心跳，或心跳已过期。',
              }),
              native?.releaseSha
                ? jsx('p', {
                    children: `Lab 部署 ${native.releaseSha.slice(0, 7)}`,
                  })
                : null,
              native
                ? jsxs('details', {
                    children: [
                      jsx('summary', {
                        children: `查看 ${native.components.length} 个实际插件`,
                      }),
                      jsx('ul', {
                        className: 'allriceRuntimeDiff__list',
                        children: native.components.map((component, i) =>
                          jsxs(
                            'li',
                            {
                              className: 'allriceRuntimeDiff__item',
                              children: [
                                jsx('strong', { children: component.name }),
                                jsx('span', {
                                  children: `${stateLabels[component.state]} · ${component.id}`,
                                }),
                              ],
                            },
                            `${component.id}:${i}`,
                          ),
                        ),
                      }),
                    ],
                  })
                : null,
            ],
          }),
          jsxs('section', {
            className: 'allriceRuntimeDiff__upgrade',
            'aria-label': 'AllRice 实际接入状态',
            children: [
              jsx('h3', { children: 'AllRice 实际接入状态' }),
              jsx('strong', {
                children: allrice
                  ? `${allrice.onlineWorkers} 个在线 Worker · DSH ${allrice.versions.join(' / ') || '版本未知'}`
                  : '接入状态未知',
              }),
              jsx('p', {
                children: allrice
                  ? `${allrice.componentCount} 个已安装配置组件 / Worker · 其中 ${allrice.enhancementCount} 个准入增强插件`
                  : status?.allrice?.status === 'unconfigured'
                    ? '尚未配置 AllRice 状态同步。'
                    : '暂时无法读取 AllRice 状态，稍后自动重试。',
              }),
              allrice
                ? jsx('p', {
                    children: `${allrice.availableSkills} 个可绑定 Skill · ${allrice.publishedSkills} 个已发布 Skill · ${allrice.publications} 个租户员工版本`,
                  })
                : null,
              allrice
                ? jsx('p', {
                    children: `更新于 ${time(allrice.checkedAt)} · Web ${allrice.webReleaseSha?.slice(0, 7) ?? '未知'} · Worker ${allrice.workerReleaseShas.map((sha) => sha.slice(0, 7)).join(' / ') || '未知'}`,
                  })
                : null,
              jsx('p', {
                children:
                  '各项能力的开关与发布结果见下方。运行配置、Skill 发布与任务授权分别核对。',
              }),
              summaryUrl
                ? jsx('a', {
                    href: summaryUrl.toString(),
                    target: '_blank',
                    rel: 'noreferrer',
                    children: '查看 AllRice 版本与能力 →',
                  })
                : null,
            ],
          }),
        ],
      });
    }

    function UpgradeCapabilities({ status }) {
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
                              children: `${group.id === 'integrated' ? (status?.allrice?.data?.capabilities.find((capability) => capability.id === item.id)?.status ?? 'AllRice 接入状态未知') : item.status} · ${item.detail}`,
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
      const status = useRuntimeStatus();
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
          jsx(LiveStatus, { status }),
          jsx(UpgradeCapabilities, { status }),
          jsx('h3', { children: '职责与接入方式说明' }),
          jsxs('div', {
            className: 'allriceRuntimeDiff__summary',
            children: [
              jsxs('div', {
                children: [
                  jsx('strong', { children: '共有' }),
                  jsx('span', { children: '两边复用的 DSH 基础能力' }),
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
          jsx(Group, { title: '共有能力', tag: '架构说明', items: shared }),
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
