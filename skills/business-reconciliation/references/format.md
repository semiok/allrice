# CNY 对账 v1 输入与输出

发票：`invoice_id,amount,currency`。回款：`payment_id,invoice_id,amount,currency`。
ID 必须非空；保留大小写（ABC 与 abc 不合并）。金额为非负十进制，最多两位小数，不接受指数、千分隔符、负数或非 CNY 币种。

脚本读取隔离工作目录的 `input/invoices.csv`、`input/payments.csv`；写入 `output/reconciliation.json` 与 `output/reconciliation.csv`。工具 inputs/outputs.path 填相对名称，不重复前缀。
JSON 字段：schemaVersion、currency、rows、issues、totals。所有 `_cents` 金额均为安全整数。
rows 每个唯一发票 ID 一条，含 invoice_id、invoice_cents、paid_cents、difference_cents、status。
status 为 matched / underpaid / overpaid / ambiguous；正差额表示仍待收款，负数表示超额。
重复发票 ID 的所有发票行不计入明确发票总额；重复 payment_id 的所有回款行不计入确定性回款。歧义会记录原始行号，不自动去重。
关联歧义发票或不存在发票的有效回款计入 unallocated_payment_cents，不能计作已对账。
totals.valid_payment_cents = allocated_payment_cents + unallocated_payment_cents。
totals.difference_cents = invoice_cents - allocated_payment_cents。
CSV 包含同样 rows 明细，文本列以单引号转义危险电子表格公式前缀。

此版本不是账务入账工具，不写回 ERP/银行，不发送外部通知；结果是基于提供输入和明确口径的核对报告。
