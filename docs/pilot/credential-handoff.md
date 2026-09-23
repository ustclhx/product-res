# 真实接入所需材料与启用顺序

这份清单用于管理员接入；合作团队使用 [试用指南](team-trial-guide.md)。代码已支持两个市场来源，但账号开通、模型资格和真实业务材料不能用测试数据替代。

## 管理员提供什么

| 项目 | 提供方式 | 当前状态 |
| --- | --- | --- |
| DataForSEO | 在 ECS `/opt/product-res-pilot/secrets/dataforseo` 保存单行 `API登录名:API密码` | 已安装且验证生效；Amazon 查询成功，取回原结果，费用 0.0033 USD |
| SerpApi | 在同目录 `serpapi` 保存单行 API key | 已安装，内部 DTC 已保存 10 条真实线索；首轮 1 次应用查询额度已用完，可打开已有批次 |
| NewAPI | 本轮改用 DeepSeek 官方渠道 1、`deepseek-v4-flash` | 三个节点的真实模型合成 smoke 已通过，详见新回执 |
| 团队入口 | 本轮确认使用 SSH 隧道，后续由用户配置现有域名的 Cloudflare 子域名 | 隧道与四个账号已验证；域名后续接入 |
| 试点材料 | 车辆内饰方向已确认；仍需供应商报价/核验材料，以及实际经营结果或真实未上市原因 | 两工作区研究标准已确认，内部 DTC 已纳入真实候选；供应与结果材料待补 |

凭据文件保持 `0600`、属主 UID `10001`，不粘贴到聊天、仓库、表格或命令行参数。可由管理员安全写入后只告知路径；不要覆盖共享 d2market 凭据。DataForSEO 的 API 密码不同于网站登录密码，位置见 [官方账号/API Access 说明](https://dataforseo.com/help-center/dfs-dashboard-how-to-find-everything)。SerpApi key 见 [账号密钥页](https://serpapi.com/manage-api-key)。

## 历史 403 及本次 DeepSeek 恢复

2026-09-20 的真实结构化生成返回 `403 / AccessDenied.Unpurchased`。当时请求命中 NewAPI 渠道 3，渠道启用、没有模型重映射；请求令牌状态有效、未过期，只允许 `deepseek-v4-flash`，内部额度为 unlimited。对应错误记录没有额度错误。因此不能把本次故障当作 NewAPI 内部额度不足来扩大共享额度。

[百炼官方错误码说明](https://help.aliyun.com/zh/model-studio/error-code) 将该码解释为服务未开通或账号资格限制。需要管理员在对应区域/工作空间检查服务开通状态。现有服务器权限不能代替云账号登录、实名认证或服务协议确认。这里只确认了上游拒绝，尚未在百炼控制台核验具体账号原因。

用户随后明确改用 DeepSeek：发现 product-res 私有凭据仍带固定渠道 3 后缀，已仅将该引用改为渠道 1。关闭思考模式并明确 FACT 引用规则后，三个节点真实生成和本地校验通过；详见 [DeepSeek 回执](deepseek-smoke-2026-09-20.json)。这没有修复或启用百炼，也没有修改共享渠道、价格、额度及 d2market 凭据。当时真实市场证据验收仍等待数据源账号，最新进展见下。

2026-09-21 更新：已使用 SerpApi 的真实、未核验观察验证 DeepSeek 补证与评估两个节点；结构与引用校验通过，币种/采购价/MOQ/车型适配仍未知。复盘节点仍待真实批准与结果材料，不能将前述合成 smoke 当作真实复盘验收。最新记录见 [真实市场接入记录](live-market-verification-2026-09-21.md)。

## 启用与验收顺序

1. 对两个工作区确认来源使用和留存范围，设置 `licensed`、`request_limit`、`retention_days`；初次各来源只放行一次查询、前 10 条。不得仅因凭据存在就声明授权范围已核验。
2. 配置 `/opt/product-res-pilot/deploy/providers.json`，恢复 NewAPI 配置前先验证推理。更新配置后重启独立 product-res API/worker，让两者读取一致配置。
3. 通过页面分别执行 Amazon US / Google Shopping US 查询，保存批次、查询条件、采集时间、缺失字段、请求状态和供应商可取得的 usage/费用。未返回费用时保持未知。
4. 显式纳入候选，保持第三方观测未核验。团队补真实报价、核验材料；验证评估整理、补证、复盘三个模型节点的引用和人工采用。
5. 合作团队与内部团队分别完成决策、验证、真实结果或未上市原因、复盘与下一轮采用。工程演练使用 TEST，不计入真实闭环。
6. 本轮通过 SSH 隧道进行受控试用。后续 HTTPS 接入时更新 `PUBLIC_URL`，验证 Secure cookie、登录、来源查询和隔离，再交付账号。继续保留当前 SSH 隧道作为管理员入口。

8.4 按用户更新后的 SSH 隧道口径验收；9.1、9.2、9.3 仍须真实调用和业务证据。当前可交付管理员做受控流程演练，尚不能宣布真实数据与模型试点验收完成。

账号开通的逐步操作见 [DataForSEO / SerpApi 官方链接与指南](market-account-setup.md)。
