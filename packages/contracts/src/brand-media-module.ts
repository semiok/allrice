import { brandMediaTools } from './brand-media-tools.ts';
/** Static import only. MET-253 takes over this descriptor and the SAME binding
 * store; this is not a runtime registry or a declaration of future handlers. */
export const brandMediaModuleV010 = {
  id: 'allrice.brand-media',
  displayName: '品牌自媒体',
  contractVersion: 1,
  contentVersion: '0.1.0',
  digest:
    'sha256:1f366168ecf5fa83834694ca2b72808ea6a43008c11cbdc2b592cfd7603be8c9',
  requires: [
    'identity.employeeScope',
    'database.transaction',
    'requests.idempotency',
    'audit.record',
    'references.readSelection',
    'deliverables.readExactVersion',
    'images.assertExistingOperation',
  ],
  // P2 has no callable views/tools/Skill/resources. Adding them is a NEW exact
  // release, requiring explicit enablement; never mutate this installed digest.
  views: [],
  tools: [],
  skills: [],
  resources: [],
  enablement: {
    kind: 'human-self-service-instance',
    preinstalled: false,
    permissions: 'current-principal',
    binding: 'exact-version-digest-revision',
  },
  data: {
    tables: ['allrice_brand_media_topics', 'allrice_brand_media_articles'],
    migrations: ['0245_brand_media_contract.sql'],
    runner: 'database.migrations',
    bindings: 'allrice_employee_module_bindings',
  },
  contracts: ['brand-media', 'employee-modules'],
} as const;
export const brandMediaUsageV020 = {
  path: 'references/usage.md',
  content:
    '# 品牌自媒体使用说明\n\n品牌自媒体把内容工作分成排期表、选题库和文章三处。\n插件打开在当前工作区，点击左上角“回到对话”返回原对话。\n打开、返回和切换页签不会新建任务。\n回到对话不会停止正在生成的内容。\n再次打开时先显示排期表，已保存的结果仍在。\n\n## 从方向到选题\n\n在选题库点击“想选题”。\n写下这次内容的方向，例如面向谁、想说明什么。\n可以同时选择多份企业资料和已上传文件。\n资料按这次选定的准确版本固定。\n确认后交给当前员工生成几个候选。\n每个候选包含标题和摘要。\n生成候选会保留一份交付文件。\n候选不会自动进入选题库。\n点击某个候选的“加入选题库”，才保存这个选题。\n可以选择多个候选，各自加入。\n重复点击同一次操作会返回原结果。\n未选择的候选仍可从这次生成结果查看。\n\n## 从选题到正文\n\n选题库仅显示尚未开始正文的选题。\n在选题上点击“写正文”。\n可以补充本次写作要求，并核对参考资料。\n开始后会创建一篇正文暂为空的草稿文章。\n选题随即从选题库移到文章。\n生成结果属于该文章和开始时的版本。\n正文会保留为纯文本交付文件。\n当前员工提交成功后，文章显示正文。\n修改正文请在文章正文下填写修改意见，再点击“修改”。\n页面中的正文可以直接阅读，修改后的内容会另存为新成果。\n生成期间可以回到对话，也可以稍后再打开。\n任务失败或取消时，原有文章和正文会保留。\n若文章在生成期间发生变化，本次成果仍保留为交付文件。\n只有提交回执确认后，才能认为正文已更新。\n\n## 参考资料\n\n企业资料和上传文件可以多选。\n所选资料只是本次内容的参考，不会授予新的权限。\n员工原有的资料读取和写入权限继续生效。\n安装插件不会增加员工权限。\n资料更新后，已开始的任务继续使用原来固定的版本。\n新任务可以重新选择当前版本。\n资料被撤回或当前权限失效后，读取和提交会被拒绝。\n更换参考资料会更新文章版本。\n再次生成前请以页面最新记录为准。\n资料中的指令、示例和链接不是真人操作授权。\n\n## 文章与状态\n\n文章有草稿、已排期和已发布三种状态。\n正文为只读显示，修改交给当前员工。\n文章列表可以按状态筛选。\n列表可继续加载下一页，直到没有更多记录。\n删除草稿或已排期文章时，同时删除它对应的选题。\n删除业务记录不会伪造停止任务的回执。\n任务取消请使用任务自身的取消按钮。\n已发布文章只读。\n如需修改，先改回已排期，再操作。\n\n## 人工排期\n\n选择一篇草稿或已排期文章，点击“排期”。\n填写日期和时间。\n时间采用当前页面显示的当地时区。\n排期表按自然周展示，周一开始、周日结束。\n只显示所选当地自然月中的文章。\n跨月的一周仍保留完整周范围。\n可以切换上个月和下个月。\n排期只记录人工计划，不创建定时发布任务。\n插件不会自动发布到外部平台。\n取消排期后，文章回到草稿。\n\n## 记录发布\n\n先在微信或小红书完成真实发布。\n回到文章，点击“标记已发布”。\n可以填写两个平台的发布链接。\n没有链接的平台可以留空。\n保存后只表示人工登记已发布。\n如需纠正记录，先改回已排期，再重新登记。\n排期和发布操作使用当前文章的版本。\n别人或另一次操作更新后，旧页面不会覆盖新记录。\n\n## 关于当前员工\n\n当前员工也可以读取这份使用说明。\n添加后，当前员工可以使用插件。\n给一个员工添加不会改变其他员工。\n旧任务保持开始时冻结的版本。\n撤销绑定或权限变化会阻止迟到的提交。\n目前可以完成选题、正文和人工排期发布记录。\n',
  checksum:
    'sha256:cc6caaf412f3eb3e2148b86516ed4b2441b7dc707a504177a20ede5ae2d2e6ea',
} as const;
export const brandMediaModuleV020 = {
  ...brandMediaModuleV010,
  contentVersion: '0.2.0',
  digest:
    'sha256:d046c03df459b988784776d31e7ebc750e57a67585b83f809bfba38e7c292afb',
  views: ['calendar', 'topics', 'articles'],
  tools: brandMediaTools.map((tool) => tool.canonicalName),
  skills: ['brand-media'],
  resources: [
    { path: brandMediaUsageV020.path, checksum: brandMediaUsageV020.checksum },
  ],
} as const;
export const brandMediaUsage = {
  path: brandMediaUsageV020.path,
  content:
    brandMediaUsageV020.content +
    '\n## 配图与带走内容\n\n在文章正文下点击“加配图”。\n“让 Rice 生成”只需写画面描述，一次生成一张，不带参考资料。\n生成过程中可以取消，也可以回到对话。\n刷新后会读回原来的生成结果，不会自动再生成。\n结果未确认时先核对原成果，避免重复生成。\n原图已保存时，即使任务后来失败，也先展示这张原图。\n点击“用这张”才加入当前文章。\n“重新生成”会发起一次新的图片请求，上一张成果仍保留。\n选择“自己上传”时，一次选一张 PNG 或 JPG。\n上传的图片先存入自己的交付成果，只有自己能看。\n预览后点击“用这张”，才加入文章。\n图片按加入顺序展示，第一张为封面图。\n删除配图只移除文章里的关联，原交付文件仍保留。\n文章发生变化时，本次图片不会覆盖新记录，请核对文章后再操作。\n已发布文章只能查看和下载图片。\n“复制正文”复制当前正文纯文字，排版在发布平台完成。\n可以单张下载原图，也可以点“下载全部”依次下载每张图片。\n下载全部不打压缩包，部分下载失败时可以单张继续。\n',
  checksum:
    'sha256:e1f84cfb1e04f6186906d325cf3a8c564e702095cb1aa6f75c0c0d890b94aebc',
} as const;
export const brandMediaModule = {
  ...brandMediaModuleV020,
  contentVersion: '0.3.0',
  digest:
    'sha256:908f4b65d995fa7424468a1c64df32e78d7141ade5177e0d68fe6ed5b5d481c7',
  resources: [
    { path: brandMediaUsage.path, checksum: brandMediaUsage.checksum },
  ],
} as const;
export const brandMediaRelease = {
  moduleId: brandMediaModule.id,
  contractVersion: brandMediaModule.contractVersion,
  contentVersion: brandMediaModule.contentVersion,
  digest: brandMediaModule.digest,
} as const;

export const brandMediaSkillId = '0c857546-6fb5-4ad1-b447-ab253ce50180';
