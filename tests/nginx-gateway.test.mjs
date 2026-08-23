import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const nginx = await readFile(new URL("../nginx/nginx.conf", import.meta.url), "utf8");
const denied = await readFile(new URL("../nginx/html/__security/denied.html", import.meta.url), "utf8");

test("只有 Nginx 向宿主机公开 42981，Web 仅暴露内部 3000", () => {
  assert.match(compose, /nginx:[\s\S]*ports:\s*\n\s*- "42981:42981"/);
  assert.match(compose, /web:[\s\S]*expose:\s*\n\s*- "3000"/);
  assert.doesNotMatch(compose, /- "3000:3000"/);
});

test("同步页面和同步 API 都经过私有地址检查", () => {
  assert.match(nginx, /geo \$internal_client/);
  assert.match(nginx, /192\.168\.0\.0\/16 1;/);
  assert.match(nginx, /location = \/sync[\s\S]*?return 403;/);
  assert.match(nginx, /location \^~ \/api\/sync\/[\s\S]*?return 403;/);
});

test("403 使用自定义深空拒绝页", () => {
  assert.match(nginx, /error_page 403 \/__security\/denied\.html;/);
  assert.match(denied, /跃迁航道未获授权/);
  assert.match(denied, /deep-space-checkpoint\.png/);
});
