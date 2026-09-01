import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import check from "node:test";

const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
const applicationDockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const nginx = await readFile(new URL("../nginx/nginx.conf", import.meta.url), "utf8");
const proxyCommon = await readFile(new URL("../nginx/proxy-common.conf", import.meta.url), "utf8");
const denied = await readFile(new URL("../nginx/html/__security/denied.html", import.meta.url), "utf8");

check("只有 Nginx 向宿主机公开 42981，Web 仅暴露内部 3000", () => {
  assert.match(compose, /nginx:[\s\S]*ports:\s*\n\s*- "42981:42981"/);
  assert.match(compose, /web:[\s\S]*expose:\s*\n\s*- "3000"/);
  assert.doesNotMatch(compose, /- "3000:3000"/);
});

check("构建代理不写入镜像环境层", () => {
  assert.doesNotMatch(applicationDockerfile, /(?:ARG|ENV) HTTPS?_PROXY/);
  assert.match(applicationDockerfile, /RUN npm install --no-audit --no-fund/);
});

check("同步页面和同步 API 都经过私有地址检查", () => {
  assert.match(nginx, /geo \$internal_client/);
  assert.match(nginx, /192\.168\.0\.0\/16 1;/);
  assert.match(nginx, /location = \/sync[\s\S]*?return 403;/);
  assert.match(nginx, /location \^~ \/api\/sync\/[\s\S]*?return 403;/);
  assert.match(nginx, /location \^~ \/api\/sync\/[\s\S]*?proxy_set_header X-Sync-Internal-Token "";/);
  assert.match(compose, /SYNC_INTERNAL_TOKEN:/);
  assert.match(compose, /SYNC_ADMIN_TOKEN:/);
});

check("403 使用自定义深空拒绝页", () => {
  assert.match(nginx, /error_page 403 \/__security\/denied\.html;/);
  assert.match(nginx, /location = \/__security\/assets\/deep-space-checkpoint-v2\.png/);
  assert.match(nginx, /alias \/usr\/share\/nginx\/html\/__security\/assets\/deep-space-checkpoint-v2\.png/);
  assert.match(denied, /跃迁航道未获授权/);
  assert.match(denied, /deep-space-checkpoint-v2\.png/);
  assert.match(denied, /class="space-fx"/);
  assert.match(denied, /class="dust"/);
  assert.equal((denied.match(/<i class="mote"><\/i>/g) ?? []).length, 12);
  assert.equal((denied.match(/<i class="meteor"><\/i>/g) ?? []).length, 7);
  assert.equal((denied.match(/<i class="stream"><\/i>/g) ?? []).length, 5);
  assert.match(denied, /@keyframes mote-drift/);
  assert.match(denied, /@keyframes meteor-pass/);
  assert.doesNotMatch(denied, /engine-(?:effects|pixels|plume|flare)/);
  assert.match(denied, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(denied, /\.space-fx \{ display: none; \}/);
});

check("Nginx 隐藏框架标识并发送浏览器安全响应头", () => {
  assert.match(nginx, /X-Content-Type-Options "nosniff" always/);
  assert.match(nginx, /X-Frame-Options "SAMEORIGIN" always/);
  assert.match(nginx, /Referrer-Policy "strict-origin-when-cross-origin" always/);
  assert.match(nginx, /Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)" always/);
  assert.match(proxyCommon, /proxy_hide_header X-Powered-By/);
});
