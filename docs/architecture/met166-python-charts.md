# MET166 PR1a：云端 Python 与中文 PNG 成果

本切片补齐云端计算的 Python/PNG 路径，供没有对应本地能力的任务使用。MET166 PR1 的本地绘图能力包和按任务本地优先选择仍由 PR1b 接 MET164 的运行时、文件接口；本切片不代表整个 PR1 完成，也不改变明确 cloud/local 工具的含义。

## 原生复用核对

| 已有入口                                                                                                           | 核对结果与本次适配                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DSH SDK `0.1.5-rc.3`，源码 `a4c74a91e06b00fe0b0937bde982170c526cc842`                                              | 保留原生 JSON-RPC、工具循环和上游字节。`allrice-cloud-native-tools.mjs` 是既有 AllRice 接线；其独立参数校验原先只允许 Node/文本，本次同步可选 language 和 PNG 声明。真实原生往返回归覆盖旧 JS、冻结脚本及 Python。             |
| 统一 Office Skill / `@deepseek-ai/dsh-skill-office@0.1.7-alpha.2`，源码 `00102833dfaee1da9f48a3a8eae9d34005a75218` | 三份上游指南、`check_office.py` 及许可证保持原始字节。根 Skill 仅加入可选 Python 图表与授权 PNG 嵌图指引，不增加另一个 Office Skill 或必需工具。Word/PPT 继续调用 python-docx/python-pptx；Excel 可编辑图表继续调用 openpyxl。 |
| `CloudRunnerBackend` / `OperationLedger` / VM watchdog                                                             | 复用同一物理容量、FIFO、租约、取消、gVisor、只读根、无网络、输出采集和恢复。增加语言执行分支与可信 PNG 检查，没有独立调度器或 Agent 循环。                                                                                     |
| StorageObject / `registerToolBrokerExport` / workbench                                                             | 实际 PNG 字节保存为 `image/png`、不可变 `format: png` 版本；沿用 `kind: file` 和授权输入、校验和、成果历史与下载。对象 ID 与版本 ID 分别返回，不能把容器路径或版本 ID 当作输入文件。                                           |
| `readStaticArtifactPreview` / `NativeDocumentPreview` / `NativeImagePreview`                                       | PNG 已有图片预览路径，本次不新增预览器或成果面板。Office 预览继续使用原有 LibreOffice/Poppler 渲染，不另建转换服务。                                                                                                           |

实际入口是已有 `cloud_process_execute`：内联 `script` 传 `language: "python"`，输入声明精确 StorageObject ID/checksum，脚本读取 `input/`，保存 `output/chart.png`，输出声明 `format: "png"` 与 `.png` path/fileName。图表产出的对象 ID/checksum 可作为同一 Office Skill 的授权 `python.inputs`，由原生库嵌入 Word/PPT 并继续原有检查/发布。

## 固定运行环境和兼容

`Dockerfile.python-charts` 固定 amd64 Python 3.11.13 基础镜像。`requirements.lock` 锁定官方 wheel 版本及 SHA256：Matplotlib 3.10.6、NumPy 2.2.6、pandas 2.3.3、openpyxl 3.1.5、Pillow 11.3.0 和完整传递依赖；安装使用 `--only-binary=:all: --require-hashes` 并执行 `pip check`。Noto CJK 固定 Debian bookworm 包 `1:20220127+repack1-1`。默认 Agg 与 CJK 字体配置、运行时/字体校验和记录和缓存种子随镜像固定。

每个调用将只读字体缓存种子复制到自身 tmpfs 中的可写 `MPLCONFIGDIR`；HOME、临时目录和缓存不跨调用共享，不在租户任务中联网装包。所用发行包保留原有许可证文件，Office 上游 MIT 资源继续保留；本次不增加 PDF 引擎或 OCR 依赖。字体包来源和 SHA256 可在 [Debian 官方包页](https://packages.debian.org/bookworm/all/fonts-noto-cjk/download) 核对，字体及 Agg 行为见 [Matplotlib 官方文档](https://matplotlib.org/3.10.6/index.html)。

旧调用不传 language 时，不补默认字段，仍使用原来的 Node 22.23.2 literal image digest；旧冻结 payload、执行摘要、配置 checksum 和 grant profile 保持。冻结 Skill 的 `.js/.mjs` 仍按现有 Node 依赖解析；Python 内联入口不借此升级旧 Skill 包。服务器由 language 选择另外的固定 Python image，并将真实 image digest 冻结到操作；模型不能提交 image/runtime/network。

V1 Python image 为 `sha256:d6a52afde3d7c99d8cba9c89ff5078a8e1b6a177f97512ff4facfa4f930fe38e`。后续运行时升级需要保留已批准的冻结镜像映射，不能原地替换 V1 常量来升级历史任务。环境探测单独检查 Python image/backend，记录在 compute 的独立 python 证据中；不改旧 grant profile，也不以一个新开关推断 Python 已就绪。执行时再次 preflight 实际选定镜像。

输入仍限已授权的 16 个 StorageObject、合计 2MB；输出最多 8 个、合计最多 4MB，单次最长 60 秒、最高 512MiB。CSV/XLSX 走原有 storage 授权、checksum 和限额，不接任意宿主路径。图表读取数据时须明确数字转换、缺失处理和编号类型；脚本退出 0 本身不能证明文件交付。

## PNG 的可信检查与发布

租户进程停止后，平台 supervisor 捕获一次已声明文件的实际字节；文件必须在输出目录内、为普通文件、不是链接并符合合计字节上限。固定镜像内只读的 `check_png.py` 用 `/opt/python/bin/python -I` 和捕获字节的 stdin 执行，Pillow `verify()` 检查包结构/CRC，重新打开并 `load()` 解码完整栅格。检查器不打开租户选择的路径，不从租户目录导入 Pillow；签名正确、CRC 正确但 zlib 无效或截断的样本仍失败。

检查限制 8192 边长、1600 万像素、4MB 输入和压缩文本内存，并拒绝动画；既有进程内存、期限和 watchdog 继续约束解码。Node 收集与 DB 发布只做窄 PNG 头、尺寸和检查报告校验，绑定捕获字节 SHA256；不重写 PNG 解码器。失败、取消、超时和输出超限不发布部分文件。私有 outcome journal 与输入 authority 绑定，恢复不能替换字节或重复执行。

watchdog 的期限使用 VM 时间。Docker 可能已确认达到固定 deadline 后退出 137，而宿主时钟尚未到限；收集器依据固定 deadline 与 Docker FinishedAt 识别该真实超时。没有这份停止证据的 137 仍失败，明确 canceled/unknown 和 OOM 保持原语义。

## 验证边界

契约回归核对旧 Node 字节/摘要、Python image/language 绑定、PNG 扩展名、路径与资源限制。原生 DSH 往返核对真实 Broker 参数；专用数据库的 UUID schema 回归核对 StorageObject/checksum、授权、PNG 版本、工作台投影、私有输入和重试不重执行。真实 gVisor 测试核对中文长标签、负数/缺失数据、CSV/XLSX 数据质量、损坏 PNG、隔离、超时、取消，以及同一 PNG 的原生 Word/PPT 嵌入字节和 Office checker。

这些后端物理测试使用诊断 UUID 和合成资料，结束后仅清理自己创建的容器与 fixture schema；它们不是 Dev 模型 Run 或前台成果验收。根代理在合并部署后另行验证普通员工、实际 Run、图片预览/下载与含图 Office 成果；Dev 交付状态以该独立验收记录为准。
