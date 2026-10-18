# 界面观察描述

- 新站注册完成后进入个人空间；此记录不保存账号邮箱或密码。
- 管理后台模型列表显示 smoke DeepSeek 文本模型、token 计费与 Enabled；创建表单显示 Saved。
- 积分调整页显示 Adjustment applied、Available 100、Held 0、Debt 0，批次 100 / 100。
- Sentry 事件详情显示 environment=smoke、dist=web、对应完整 release 和 requestId。堆栈在 ../../src/server/sentry-test.ts:32:9 的 sentryTest，显示 throw new Error 的源码上下文，另一帧为 ../../src/server.ts:50:26。

仅保存界面描述；截图中可能包含账号邮箱，因此不保存原始截图。

- Neon 控制台显示 Project product-res-smoke was successfully deleted；项目列表回到原有两个项目。
