# 首轮 OEM 选品验证：2024 Toyota RAV4 LE

执行日期：2026-09-21。结论：**资料预核验已完成，车型适配未通过放行，实车测试未执行。** 此处“未通过放行”表示材料不足，不表示已证明不兼容。

## 已选定方向

- 采购：无品牌/OEM，黑色座椅背收纳袋，9 袋、平板袋，目标每销售套两只。两只装是采购要求，不是供应商已确认的包装事实。
- 首选询价对象：Qeepei Auto (Ningbo)，Alibaba 商品 `1601043417942`。该商品与研究功能接近；选择用于核规格和询价，并非确认供货能力或下单。
- 市场对照：Helteko `B07RNZV64Y`。与 OEM 候选分开建档，历史零售价不变成 OEM 成本。
- 车辆：美国版 Toyota RAV4，2024 年款，LE，汽油 FWD；本轮手册范围限定加拿大生产、截至 2024 年 6 月生产版本。实际取车时核生产铭牌和随车手册，不能自动覆盖其他生产版本。
- 座椅：原厂前排织物独立座椅，驾驶席六向、副驾四向调节，分体可上下调节头枕；左右前排分别记录结果。

选择理由是官方资料可取得、可明确限定座椅配置，便于把本轮任务变成可复核的案例；不代表已验证其市场销量或适配优势。

## 一手资料

1. [Toyota 2024 RAV4 美国配置册](https://www.toyota.com/content/dam/toyota/brochures/pdf/2024/rav4_ebrochure.pdf)，PDF 第 9 页 LE 配置：织物座椅、驾驶席六向、副驾四向、FWD。
2. [Toyota 车主手册 OM0R147U](https://assets.sia.toyota.com/publications/en/om-s/OM0R147U/pdf/OM0R147U.pdf)，第 144、150–151 页为前排调节和头枕；第 41、44–45 页为附件、气囊和副驾负载限制。官方文件已下载并抽取相应页，头枕图已目视核对。SHA256：`137bdeb7c3af3313c0594c275cb9eb63f167de88a2e478f758035a578fbd3f56`。
3. [Toyota 2024 手册目录检索入口](https://www.toyota.com/owners/warranty-owners-manuals/digital/article/rav4/2024/om42f42u/ch04se050408/)，检索索引将 OM0R147U 对应加拿大生产、截至六月版本；目录动态渲染不稳定，取车仍需按铭牌复核。
4. [Qeepei 精确商品](https://www.alibaba.com/pla/Factory-Custom-Waterproof-Luxury-Model-Car_1601043417942.html?biz=pla&mark=google_shopping&pcy=us_en&product_id=1601043417942&searchText=car+organizers)：仅公开索引可读，正文抓取失败。材料/功能为销售声明；价格 USD 3.08–3.38、MOQ 500 的单位和有效期仍未确认。详见[供应商规格核验](qeepei-fitment-specs-2026-09-21.md)。

## 本轮已执行的七项资料检查

| 编号 | 检查 | 实际结果 | 依据 / 尚缺材料 |
|---|---|---|---|
| D01 | 目标车型与配置可以明确 | 资料确认 | 官方配置册，实际车辆尚未取得 |
| D02 | 前排座椅面料及调节类型 | 资料确认 | 织物，驾驶席六向/副驾四向；不外推到其他配置 |
| D03 | 头枕是否分体可调 | 资料确认 | 手册第 150 页图文；没有取得杆距或绑带尺寸 |
| D04 | 面板展开尺寸与椅背匹配 | 待资料 | 该 SKU 展开尺寸、实车椅背测量均缺失 |
| D05 | 上下绑带范围及固定路径 | 待资料 | 缺最短/最长长度、扣具位置、左右座椅安装图 |
| D06 | 是否避开气囊和副驾感应限制 | 待资料 | 手册存在明确限制；没有该 SKU 安装路径和证明，不能仅看外观放行 |
| D07 | 负载、调节、后排空间与功能 | 待实测 | 无样品、实车、供应商负载说明，未做承重或驾驶试验 |

结果为 3 项资料确认、4 项未满足条件；没有一项实车适配“通过”。仅确认有可调头枕，不能推导产品装得下。手册限制要求附件不能影响相关气囊区域，副驾附属部位不能施加重载；尚无材料证明本候选满足。

## 下一轮实物验证工单（未执行）

负责人：项目分析负责人负责协调；采购提供供应商资料及样品，具有车辆操作经验的测试人员执行实车记录。现阶段没有真实采购/测试成员分配，因此系统不会虚构具体执行人。

1. 取齐确切 SKU 的尺寸图、绑带范围、扣具位置、安装说明、负载限制及与选定车辆的限制说明；确认样品与图纸版本一致。
2. 核对车辆年款、配置、生产年月、座椅原厂状态及随车手册；记录样品编号和两只包装内容。与本轮范围不同则重新核验，不套用结论。
3. 在停车状态下按厂家说明分别核对左右前排的空载固定、头枕锁定、座椅调节和后排空间，保存带尺照片。若安装说明不足，或涉及气囊区域/感应系统的不确定影响，先由厂商或合格专业人员确认再继续；普通安装观察不能认证气囊安全。
4. 仅在确认厂家允许负载和安装范围后制定具体负载项目；当前不设任意重量作“通过”标准，不进行碰撞或气囊触发试验。
5. 按具体车型与左右座椅记录“通过 / 不适配 / 未测”，保留原始照片、测量、操作者和日期。若仅驾驶席满足，不宣传两只套装覆盖整车。

## 采购询价补充项（草稿，未发送）

请针对 Alibaba 商品 1601043417942 报无品牌黑色版本，目标两只一套，50/100/300/500 套四档；明确能否按此包装，不将 MOQ 500 默认换算为 250 套。提供样品数量/价格/交期、正式报价、EXW/FOB 地点、有效期及包装运税范围。

安装目标为美国版 2024 Toyota RAV4 LE 汽油 FWD、原厂前排织物座椅和可调分体头枕。请提供对应 SKU 展开尺寸、上下绑带最小/最大长度、固定路径、扣具位置、负载限制以及该车型已有测试资料；无该车型验证请明确写未验证。

English addendum: Target vehicle is a US-market 2024 Toyota RAV4 LE gasoline FWD with original front cloth seats and separate height-adjustable head restraints. For item 1601043417942, provide dimensioned drawings, upper/lower strap ranges, buckle locations, installation routing, load limitations and any vehicle-specific test records. Clearly state if this vehicle has not been tested. Requested retail pack: two organizers; please confirm feasibility and separate sample, stock and customized-packaging MOQs.

## 流程结果与限制

本轮以真实公开资料执行补证流程，不产生假报价、假适配或假经营结果。OEM 独立建档；资料核验任务可完成，实车适配任务维持阻塞。正式采购价、MOQ、车辆适配以及 OEM 自身的市场售价依据仍缺失，因此不提交采购审批。后续模型输出仅作补证草稿，不能替代以上资料判断。

实际系统回执：OEM 候选 `96d1f1a5-c746-430a-9d96-3292fccb1a07`。资料核验任务 DONE，采购价/MOQ/售价任务 TODO，实车适配任务 BLOCKED。筛选仍缺 currency、moq、price、procurement_cost、vehicle_fitment。7 项系统一致性检查全部通过，均为业务状态检查，不是产品性能测试。

本次真实 DeepSeek 调用 `55a9a786-72ce-4395-b123-1dd35bfbe075` 返回 `NEWAPI.OUTPUT_TRUNCATED`，未形成可采纳草稿；未用模型失败结果作为证据。人工资料核验和任务已保存。见[执行回执](../docs/pilot/rav4-oem-validation-receipt-2026-09-21.json)。
