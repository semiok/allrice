# MET164 PR1：原生 Office 本地可行性实验

2026-10-01，第一批开工基线为 `origin/main 1b22ec155f8fa569be3533d236ca5c1599cb43a3`，当时 Dev Web/Worker 为同一提交。本实验只为 PR4 的执行接入提供证据，不开放本地 Office，也不改现有云端 Office。

## 复用来源与准备

沿用已经交付的单一 Office Skill、`references/xlsx.md` 和 `scripts/check_office.py`。这两个资源来自固定 `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`，原始字节未改动；来源与许可见 [provenance.md](../../skills/office/references/provenance.md)。按原生指南使用 openpyxl 的读取、局部修改、另存和重新打开流程，不增加替代文档引擎。

本机为 macOS 15.7.9 / x86_64。复用 uv 已管理的 CPython 3.12.13，在任务证据目录准备独立 venv，使用与现有 Office 镜像一致的 openpyxl 3.1.5（et-xmlfile 2.0.0）。没有改用户全局 Python、Bridge 安装配置或业务资料。uv 管理的运行时与 venv 包隔离不等于 OS 沙箱；解释器管理依据 [uv 官方说明](https://docs.astral.sh/uv/concepts/python-versions/)。

## 固定任务与实际结果

固定合成输入 `中文任务/input/原始对账.xlsx` 含编号 `00123`、金额 `30`、公式 `=B2*2` 和粗体表头。只将金额改为 `35`，另存 `中文任务/output/验证结果.xlsx`，重新打开检查编号、公式和表头保留。原始输入 checksum 不变。

| 检查                                              | 结果                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| 管理的 Python 与现成原生库启动                    | 通过，CPython 3.12.13 / openpyxl 3.1.5                              |
| 中文目录/文件名、读取、修改、重新打开             | 通过，输出 4,958 字节                                               |
| 上游 checker 的 OOXML 包、文本、表数检查          | 通过，1 张表、6 个有值单元格、1 个公式                              |
| 只读输入、越过 output 的写入、output 符号链接逃逸 | 均被 OS 拒绝，输入与外部哨兵原字节保留                              |
| 运行中取消                                        | 受控子进程收到 SIGTERM 后退出，观察约 1ms；单次样例，不作为速度承诺 |

原生资源 SHA256：指南 `b8394b54de0d14c90e6377351c7cf871753cede404528c031abf8b056f96880a`，检查器 `d94afa67593a284751e0f2dc000877e836f885d39954a882033cf22a13278f66`。

实验使用 macOS 自带 `sandbox-exec` 限制写入到 output 和本任务临时目录，固定任务不访问业务账号或资料。它只验证写目录边界与取消，不是新的 Bridge 后端。最初尝试收紧读路径时解释器启动被 OS 中止；保留失败证据后，最终实验明确允许运行时读取，只验证写边界。不能据此宣称完整读取隔离、网络策略或任意生成代码已通过。macOS 实际生产执行边界仍复用现有隔离后端，由 PR4 接入和验证。

## 复现与后续接线

脚本为 [met164-native-office-feasibility.py](../../scripts/acceptance/runtime/met164-native-office-feasibility.py)，显式传入已经准备好的 Python 和全新证据目录：

```sh
python3 scripts/acceptance/runtime/met164-native-office-feasibility.py \
  --python /absolute/prepared-venv/bin/python \
  --evidence /absolute/new-evidence-directory
```

本次机器上脚本、三次尝试、checker JSON、输入/输出字节与 profile 保存在任务的独立交付记录中。正式成果传输和发布、公式计算、预览、Word/PPT、macOS arm64、客户端运行时准备/分发及生产执行策略仍未验。PR3 补文件交接，PR4 通过现有 Bridge 账本、租约、取消、原生检查与成果发布接线，再将对应本地能力标为可用。Windows 暂缓。
