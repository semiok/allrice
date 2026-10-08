# 版本交付与复核

调用 `workspace_project` 的 `deliver`，project 使用本次工具返回的完整版本，baseline 使用实际初始版本或上一版交付。不要自行拼造存储对象、成果 ID 或校验和。下面只演示引用结构，所有占位符必须由原始回执替换：

```json
{
  "action": "deliver",
  "project": {
    "projectId": "$PROJECT_ID",
    "snapshot": {
      "kind": "storage_object",
      "id": "$SNAPSHOT_ID",
      "checksum": "$SNAPSHOT_CHECKSUM"
    }
  },
  "baseline": {
    "projectId": "$PROJECT_ID",
    "snapshot": {
      "kind": "storage_object",
      "id": "$BASELINE_SNAPSHOT_ID",
      "checksum": "$BASELINE_SNAPSHOT_CHECKSUM"
    }
  }
}
```

交付前核对以下内容：

- 源码 ZIP、测试记录和差异来自同一项目版本；失败回执保留。交付工具生成下载文件不等于所有测试已经通过。
- 构建成果是实际执行生成并收集的文件。声明离线可用时，必须确实不依赖远端脚本、字体、接口或仅本地可见的绝对路径。
- README 说明用途、依赖、启动/测试/构建命令和限制。用户的数据默认留在输入与授权范围，不添加遥测或远端上传。
- 预览入口对应本次准确版本，访问和租期依据回执；普通用户从工作台打开，不能用管理员成功替代用户可用性。
- 数据工具保留原始字符串、前导零和异常行；明确格式与精度。浏览器展示输入采用安全文本，表格导出需考虑公式字符串，不能静默丢弃冲突数据。
- 第二版保留上一版源码和成果，说明本次修改、复用和新增验证；不要把旧测试、旧预览或旧报告冒称第二版结果。

最终回复用简短文字说明完成了什么、真实测试结果、实际源码/成果链接和预览使用方式。存在未完成、失败或待确认项时明确列出，不能仅因为 Run 结束就宣布交付。
