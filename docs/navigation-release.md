# V2.1 导航发布说明

本版本在既有 V2 业务库旁新增导航缓存和小时地理任务，不重建或替换 LP、订单、合同、历史数据。首次部署导航不能只更新 Web：还需初始化目标机器上的静态资料与动态缓存，并更新同步器和网关。

## 发布前提

- 从 Git 检出发布版本；数据库、配置、日志、证书与本地运行目录不进入仓库或镜像。
- 备份目标数据库及部署配置，SQLite 使用一致性备份，不直接复制活动数据库文件。
- 目标环境已有标准 SDE ZIP；若缺失或校验失败，先解决 SDE 来源，不复制开发机业务数据库代替初始化。
- 核查 CPU 与内存：默认 `auto` 在少核机器会减少计算线程，不直接照搬测试机并发数。显式增加 `JUMP_COMPUTE_WORKERS` 前需在目标机器复测。
- 计算入口只经 Nginx 暴露，应用端口保持内部网络；同步与管理入口继续仅限可信网络。
- 如果 CDN／上层代理终止 HTTPS，在目标环境配置 `JUMP_PUBLIC_ORIGIN` 为用户实际访问的完整 Origin（仅协议、域名及必要端口）。同时审计网关的可信代理／真实来源解析，否则所有用户可能共用上层代理的来源配额；不可直接信任任意客户端传来的来源头。未完成该检查前不切换公开服务。

## 生成导航基线

在新版本镜像内、使用目标环境自己的运行目录执行。下列命令以已有 `/v2/sde.zip` 为例；运行前确认 Compose 使用正确的配置与挂载。

```bash
docker compose build web nginx
docker compose run --rm --no-deps sync node scripts/v2/export-star-map.mjs /v2/sde.zip /v2/star-map.json
docker compose run --rm --no-deps sync node scripts/v2/export-jump-ships.mjs /v2/sde.zip /v2/jump-ships-current --refresh
docker compose run --rm --no-deps sync node scripts/v2/export-jump-demo.mjs /v2/sde.zip /v2/jump-ships-current/jump-ships.json /v2/jump-demo.json
```

舰船审计读取晨曦公开 ESI，需要联网和一定时间；失败时停止，不用国际服数值填充。生成器不修改业务库。产物保留在目标环境运行目录，不能提交 Git。

## 首次初始化与切换

1. 镜像构建完成、基线验证通过后，在维护窗口停止旧同步器。确认旧写入器退出，不同时运行两个同步器。
2. 通过新镜像仅运行一次 `node scripts/v2/cli.mjs sync geography`：创建增量导航表与任务，导入星图／舰船基线，并读取晨曦动态资料。失败时查看具体数据源，不能把失败当作空入侵名单。
3. 新 Web、同步器与网关切换到同一发布版本。构建时清空 HTTP／HTTPS 代理配置；保留目标环境原有数据卷、管理口令和网络安全限制。
4. 校验地理任务成功、导航目录完整、入侵缓存未过期，再确认导航对外可用。保留原始备份，不执行清库、重新导入 LP 或全量历史同步。

后续由 `geography` 小时任务维护动态数据；不是用户点击计算时现场查询 ESI。详见[地理缓存](geography-cache.md)。

## 验收

- 容器健康、主页显示版本正确；LP 选项／详情正常，受全局策略排除的企业直达仍为 404。
- `/navigation`、`/navigation/jump` 能加载；目录、站点和动态缓存来自目标数据库。
- 常规导航、三点旗舰路线、高安收尾、不可达转手动、一跳可达和测距分别验证。
- 连点只发起一次任务；取消／改点／离开能释放任务；超量有明确提示，计算不拖慢首页和 LP。
- 桌面与手机均核对；确认同步器使用新版本，原有任务配置与 LP 数据未被重置。

已知非阻断显示问题：多条长路线的密集星系标签可能重叠；放大地图或查看路线列表可辨认，不影响寻路结果。

测试机的并发结果见[性能复测](navigation-concurrency-report-2026-10-20.md)，不能直接当作目标服务器容量承诺。实际远端更新需再次确认；只推送 Git 不等于已完成远端部署。
