# 会话时间

继续复用 DSH `0.1.7-rc.1` 的 `SessionRowItem`、`relativeTime` 和中文词条：行内显示“刚刚 / N分钟 / N小时 / N天 / N个月 / N年”，悬停显示“……前”。来源与补丁由 `apps/web/app/dsh-upstream/upstream.json` 的 `employee-workspace` 登记，不另写格式化算法。

传入原生组件的 `updatedAt` 代表会话活动：创建、发送消息以及用户改名、调整可见范围、归档或恢复。员工发布、派驻、版本选择和灰度切换只更新版本绑定，不改变会话时间或排序。后台员工更新不能让历史会话看起来刚刚发生。

迁移 `0120_session_activity_recency.sql` 根据消息时间和用户操作审计恢复此前被批量版本更新污染的时间，空会话回退到创建时间。列表、分页游标和会话详情继续读取同一时间字段，保留 PostgreSQL 微秒分页精度；消息内容与执行记录不变。
