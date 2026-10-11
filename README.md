# 晨曦服 LP 与合同分析 · V2.0.1

面向 EVE Online 晨曦服的 LP、蓝图、脑插套装与合同分析工具。市场订单和公开合同使用伏尔戈星域数据，历史成交作为参考；估值不构成成交保证。

## 数据与同步

业务只读取 V2 SQLite 数据库，不再包含旧库或旧同步器的运行回退。

- 物品主表：先单独导入 CCP 标准 SDE，再手动同步晨曦全量物品 ID，补齐信息。SDE 导入不自动触发其他任务。
- 势力、军团、LP：手动同步 ESI，人工维护标记在后续同步中保留。
- 订单：默认每 15 分钟发布完整快照；失败不替换上一轮数据。
- 合同：默认每 30 分钟同步目录，复用有效明细缓存；无效合同略过，下一轮不再出现的合同清理。
- 历史：默认每日 00:30 同步，并保存持久化断点。
- 排行榜：默认每日 09:00、15:00、18:00、21:00 重算。

时区为 Asia/Shanghai。同步页支持自动开关、可视化/Cron 配置、手动运行、暂停、恢复及导入导出。订单、合同不允许人工导入或保护。同步日志保留一周；DEBUG 按需开启。

价格、屏蔽、材料深度与榜单去重保持原有业务口径。默认无效来源策略集中在 `lib/data-policy.ts`，人工屏蔽通过同步页维护。

## 部署与初始化

新机器首次部署使用 `git clone`；已有工作副本更新时才使用 `git pull --ff-only`。

```bash
git clone <repository-url> eve-lp-calculator
cd eve-lp-calculator
mkdir -p docker-data/v2
docker compose up -d --build
```

运行数据保存在 `docker-data/v2/`，不进入 Git 或镜像。首次部署同步器创建表结构；Web 在数据未就绪时报告错误，不会回退旧库。管理入口是 `/sync-v2`，`/sync` 重定向到该页。

项目根目录 `.env` 中配置 `SYNC_ADMIN_TOKEN`，重新创建 Web 容器生效。配置为空则不要求口令；有配置时必须完全匹配。浏览器只在当前标签页保存口令。管理入口必须保持私网限制，不等同于用户身份认证。

初始化顺序：先单独导入标准 SDE，再运行物品、势力军团 LP、订单、合同、历史同步，最后完成榜单。

SDE 当前使用专用命令行导入，不是同步页的 JSONL 修复包上传：从官方 URL 下载 JSONL 格式 ZIP，或准备已下载的文件，放到 `docker-data/v2/sde.zip`。停止后台后执行独立导入，再恢复后台；导入报错时先修复文件，不继续物品同步：

```bash
docker compose stop sync
docker compose run --rm --no-deps sync node scripts/v2/cli.mjs sde /v2/sde.zip
# 上一条命令成功后再执行
docker compose up -d sync
```

SDE ZIP 文件须留在运行目录，后续物品同步会核对它与已导入版本的哈希。导入本身不排队其他任务。

核心模块成功后执行正式就绪校验：

```bash
docker compose exec sync node scripts/v2/cli.mjs enable
```

校验数据库完整性、核心表、完整订单/合同快照及历史榜单后，才允许业务读取；失败会报告原因。

更新前备份数据库及配置，更新后检查容器健康和页面。SQLite 使用 WAL，运行中不可只复制 `.db` 文件作为备份，应使用在线备份或 `VACUUM INTO`。备份不得进入公开仓库。

V1 升级为破坏性结构变更：本版本不自动读取或迁移 V1 数据库，不能只拉取代码就假设旧数据仍可使用。须先完成独立 V2 初始化和就绪验证，再切换；旧数据库保留为离线备份。详见 [正式运行与清理说明](docs/v2-production.md)。

## 本地检查与隐私

需要 Node.js 22.13+、Python 3（SDE 解析）与 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run lint
npx tsc --noEmit
```

生产路径为 Docker Compose、Nginx、Node 与 SQLite。其他静态托管不能直接替代 Docker 部署。

军团收藏使用当前浏览器的本地存储，不提供账号系统。环境文件、数据库、日志、私钥、备份与运行目录必须同时被 Git 与 Docker 忽略。`/sync-v2`、`/api/v2/*` 仅限可信网络；部署者应核查访问限制与日志轮转。远端部署须另外确认。
