# Allrice 米星标志

采用已确认的八粒米星方案：七粒炭黑 / 米白，右上较长的一粒为纯色亮黄金黄。字标使用小写 `allrice`，`i` 的点呼应金色米粒。标志不使用渐变、高光或发光效果。

- 亮黄金黄：`#F2BD16`
- 炭黑：`#24251F`
- 米白：`#F8F6EF`

矢量母版位于 `apps/web/lib/brand/rice-star.ts`，网页的 `AllriceMark` 和浏览器图标共用同一组路径。浏览器图标使用深底米白图形，保证浅色和深色标签栏的识别度；包含 SVG、16/32/48 像素 ICO 和 180 像素 Apple touch icon。

修改母版后执行 `pnpm exec tsx scripts/generate-brand-icons.ts`，提交生成的静态文件。图标 URL 带版本号，后续更换时同时更新 `layout.tsx` 与 `proxy.ts` 的公开静态资源列表。DSH 上游组件、员工头像与员工配色不属于平台标志，不随此修改。

原确认稿保存在本目录的 `approved-reference.png`，仅用于设计对照，网页加载矢量资源。
