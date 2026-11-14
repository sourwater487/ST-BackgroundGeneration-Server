# Background Generation Server 0.5.0

为离席续杯 UI 0.6.0 保留原始生成响应。浏览器连接关闭不会取消服务端请求；显式 cancel 会取消。只允许转送 ST 聊天生成路由和 Vertex PayGo 的 native-gemini/generate 路由，不接受任意目标 URL。

支持 OpenAI SSE 的完成标志和 Vertex / Gemini 原生 candidates.finishReason。意外 EOF 标记失败，保留已收到的片段。结果在前端确认交付前保留，运行中的任务不能删除。

任务仍保存在内存中，重启 ST 会丢失任务；更新前应确认任务队列为空。既有 Web Push 配置不变。

运行 `npm test` 验证真实 HTTP 断连、原生 Vertex 路由、截断判定和主动停止。测试使用临时目录与本地模拟上游，不访问真实模型。

当前部署目录为 /home/linche/apps/SillyTavern/plugins/ST-BackgroundGeneration-Server，由 sillytavern.service 加载。更新后重启该服务；通过 /api/plugins/background-generation/health 检查版本。
