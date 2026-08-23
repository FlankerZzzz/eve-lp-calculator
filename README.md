# EVE LP Calculator 项目说明

这是一个 EVE Online LP 商店兑换收益分析工具，用于查询势力、军团和企业的 LP 兑换方案，并结合吉他区域市场数据计算材料成本、产出物价值、利润和 LP 比例。

## 当前版本

当前基线版本：`V1.1`

版本更新记录统一维护在 [`VERSION.md`](./VERSION.md)。后续功能更新应同步修改网页底部版本号和版本记录。

## 主要功能

- 选择势力、军团和企业，查看 LP 商店兑换方案。
- 材料成本按当前卖单价计算。
- 产出物支持当前最低卖单价和当前最高收单价。
- 最大利润：按最低卖单价出售产出物计算。
- 最小利润：按最高收单价出售产出物计算。
- LP 比例：按保守的最小利润计算。
- 自动解析蓝图制造材料、蓝图成品和材料价格。
- 材料和成品支持市场订单弹窗查询：
  - 当前收单五档；
  - 当前卖单五档；
  - 最近 30 日历史成交；
  - 每日均价、最高价、最低价和成交量。
- 自动识别 Alpha–Omega 六件脑插套装，显示单件市场订单、整套市场价值、总 LP 和整套 LP 比例。
- 企业 LP 组合优化，支持整套脑插兑换估算。
- 首页热门物品榜和高 LP 比率榜，支持前 100 条和 10/20/50/100 条分页。
- 增效剂蓝图默认过滤，并保留手动显示按钮。
- 移动端卡片布局和桌面端表格布局。
- 物品、势力和军团图标通过 EVE Image Service 获取，并提供回退逻辑。

## 数据库结构

当前生产 Docker 环境使用本地 SQLite 数据库，容器内路径为：

```text
/data/eve-lp.db
```

宿主机通常挂载到项目目录：

```text
docker-data/sqlite/eve-lp.db
```

数据库访问层采用 Cloudflare D1 风格接口，因此可以保留向 Cloudflare Workers + D1 迁移的可能性，但当前不是在线 Cloudflare D1。

主要数据表：

| 表 | 用途 |
| --- | --- |
| `factions` | 势力基础资料 |
| `corporations` | 军团/企业基础资料 |
| `item_types` | 物品类型和同步状态 |
| `lp_offers` | LP 商店兑换方案 |
| `lp_offer_materials` | LP 兑换所需材料 |
| `blueprint_recipes` | 蓝图成品关系 |
| `blueprint_materials` | 蓝图制造材料 |
| `market_daily` | 历史日线成交 |
| `market_orders` | 当前市场订单摘要 |
| `market_order_levels` | 当前买卖五档 |
| `ranking_snapshots` | 首页榜单快照 |
| `sync_jobs` | 同步任务状态 |
| `sync_events` | 同步事件和错误记录 |

GitHub 仓库只保存代码和文档，不包含数据库文件。迁移到新机器后，需要重新执行基础资料、历史成交和当前订单同步。

## 市场同步策略

默认 ESI 地址：

```text
https://ali-esi.evepc.163.com
```

默认同步区域：

```text
10000002（吉他区域）
```

同步任务包括：

1. 基础资料：势力、军团、物品、LP 商店和蓝图。
2. 历史成交：30 并发滑动窗口，自动重试。
3. 当前订单：50 并发滑动窗口，批量写入 SQLite。
4. 榜单重算：每日生成热门榜和高 LP 比率榜快照。

历史成交现在同时覆盖 LP 产出物、LP 材料、蓝图成品和蓝图材料。不可交易、不存在或被策略隐藏的物品会跳过，420、429、502 等错误会记录并继续处理。

## 本地开发

环境要求：

- Node.js 22+
- Git
- npm 或 pnpm
- Docker（推荐用于本地 SQLite 环境）

基础启动方式：

```bash
git clone https://github.com/FlankerZzzz/eve-lp-calculator.git
cd eve-lp-calculator
npm install
npm run dev -- --host 0.0.0.0 --port 3000
```

访问：

```text
http://服务器IP:3000/
http://服务器IP:3000/sync
```

## Docker 部署

推荐使用生产构建启动：

```bash
docker compose build
docker compose up -d
```

检查服务：

```bash
docker compose ps
curl -f http://127.0.0.1:3000/
```

数据库目录和备份目录不应提交到 Git：

```text
docker-data/
backups/
```

## 配置项

可以创建 `.env`：

```env
ESI_BASE_URL=https://ali-esi.evepc.163.com
```

`.env` 只能保存在服务器或本地部署环境，不要提交到 GitHub。

## 同步接口说明

同步页面只是操作界面，实际执行同步的是以下 API：

| API | 方法 | 用途 |
| --- | --- | --- |
| `/api/sync/status` | GET | 查询任务进度、阶段、错误和最后接口 |
| `/api/sync/catalog` | POST | 基础资料同步 |
| `/api/sync/history` | POST | 历史成交同步 |
| `/api/sync/orders` | POST | 当前订单同步 |
| `/api/sync/linked` | POST | 关联同步 |
| `/api/sync/rankings` | POST | 手动重算首页榜单 |
| `/api/sync/control` | POST | 暂停、恢复和重新同步 |

生产部署已在 `docker-compose.yml` 中包含 Nginx 网关：

```text
客户端 -> 宿主机 42981 -> eve-lp-nginx:42981 -> eve-lp-web:3000
```

Web 容器的 3000 端口只通过 Docker 内部网桥向 Nginx 开放，不再映射到宿主机。Nginx 根据 TCP 连接的真实来源地址判断内外网：RFC 1918、IPv4/IPv6 回环、IPv6 ULA 和链路本地地址可以访问 `/sync`、`/sync/*`、`/api/sync` 与 `/api/sync/*`；公网来源返回带深空检查站主题的 HTTP 403 页面。不要直接信任客户端提供的 `X-Forwarded-For`。

如果未来在 Nginx 前再增加 Cloudflare、负载均衡器或其他反向代理，必须先为固定代理地址配置 Nginx Real IP 信任链，否则 Nginx 看到的是代理地址，内外网判断将不符合预期。

## 数据和计算口径

- 材料使用当前卖单价，代表买入材料的保守成本。
- 成品使用当前收单价，代表立即出售的保守收入。
- 利润会扣除材料成本和交易税。
- 首页榜单不计算个人可兑换量，只展示市场和 LP 指标。
- 企业详情页才显示基于当前 LP 的可兑换次数。
- 单个浏览器的 LP 和组合计算结果保存在浏览器本地，不写入公共数据库。
- LP 计算输入上限为 `99,990,000 LP（9999 万）`，用于防止异常输入造成计算资源消耗。

## 安全建议

如果服务只在内网使用，风险较低；如果通过公网域名访问，建议：

1. 只公开 Nginx 的 42981 端口，不要恢复 Web 容器的宿主机端口映射。
2. `/sync` 和 `/api/sync/*` 默认只允许私有网络来源；跨公网管理时优先使用 VPN。
3. 进一步增加应用层管理员密码，使用 HttpOnly Cookie。
4. 对同步 POST 接口增加 CSRF 防护和失败限流。
5. `.env`、数据库文件和备份文件不要提交到仓库。

## 版本发布流程

每次发布建议按以下顺序执行：

1. 修改代码和测试。
2. 更新网页版本号。
3. 在 `VERSION.md` 添加版本记录。
4. 运行测试：

   ```bash
   docker compose run --rm web node --test tests/rendered-html.test.mjs
   ```

5. 构建并重启 Web 容器。
6. 检查首页、企业详情、同步页面和容器状态。
7. 提交并推送 GitHub `main` 分支。

