export const mysqlMcp = {
  id: "mysql",
  name: "MySQL MCP",
  description: "连接本机 MySQL，只读查看表结构并查询数据。",
  // This is an internal catalog key; tool calls are relayed through BrowserBridge.
  url: "http://127.0.0.1:8931/mysql-mcp",
} as const;
