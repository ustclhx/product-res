# marketing-site Specification

## Purpose

提供站点对未登录访客展示的内容：营销首页、定价、博客、法律页与可选文档站，并保证这些页面快速加载、与实际套餐数据一致。

## Requirements

### Requirement: 营销页预渲染
首页、定价页、博客文章与法律页 SHALL 以预渲染或可缓存的方式提供，访客请求 MUST NOT 依赖实时数据库查询才能显示主体内容。

#### Scenario: 数据库不可用时访问首页
- **WHEN** 数据库暂时不可达，访客打开首页
- **THEN** 首页主体内容正常显示

### Requirement: 定价与实际套餐一致
定价页展示的套餐、价格与积分 SHALL 来自系统中的套餐数据，套餐变更后 SHALL 在缓存刷新后（不超过 1 小时）反映到定价页。

#### Scenario: 修改套餐价格
- **WHEN** 管理员修改了 Pro 套餐的月付价格
- **THEN** 1 小时内定价页显示新价格

### Requirement: 博客
站点 SHALL 提供博客列表与文章页，文章由仓库中的 MDX 文件生成，支持标题、摘要、发布日期、封面与标签；未到发布日期或标记为草稿的文章 MUST NOT 出现在生产环境。

#### Scenario: 草稿文章
- **WHEN** 一篇文章标记为草稿
- **THEN** 生产环境的列表、站点地图与直接访问都看不到它

### Requirement: 法律页
站点 SHALL 提供隐私政策、服务条款与退款政策页面，退款政策 SHALL 说明取消订阅与删除账号默认不退款、可通过退款申请提出。

#### Scenario: 访问退款政策
- **WHEN** 访客打开退款政策页
- **THEN** 页面说明默认不退款及申请退款的途径

### Requirement: 可选文档站
`features.docs=true` 时站点 SHALL 提供带侧边导航与搜索的文档页面；关闭时文档路由 MUST 返回 404 且不出现在站点地图中。

#### Scenario: 关闭文档站
- **WHEN** `features.docs=false`，访客访问 `/docs`
- **THEN** 返回 404

### Requirement: 暗色模式
站点 SHALL 支持浅色、深色与跟随系统三种主题，用户的选择 SHALL 在刷新后保留，首次渲染 MUST NOT 出现主题闪烁。

#### Scenario: 选择深色后刷新
- **WHEN** 用户选择深色主题后刷新页面
- **THEN** 页面直接以深色渲染，没有先浅后深的闪烁
