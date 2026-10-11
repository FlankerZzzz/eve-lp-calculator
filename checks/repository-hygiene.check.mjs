import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import check from "node:test";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");
const rules = contents => new Set(contents.split(/\r?\n/u).map(line => line.trim()).filter(Boolean));

check("Git 与 Docker 构建上下文排除本地隐私文件和运行数据", async () => {
  const [gitignore, dockerignore, dockerfile] = await Promise.all([
    source(".gitignore"),
    source(".dockerignore"),
    source("Dockerfile"),
  ]);
  const gitRules = rules(gitignore);
  const dockerRules = rules(dockerignore);

  for (const rule of ["/AGENTS.md", ".env*", ".npmrc", ".netrc", "/.data/", "/docker-data/", "*.db", "*.db-*", "*.sqlite3-*", "*.key", ".ssh/"]) {
    assert.ok(gitRules.has(rule), `.gitignore 缺少 ${rule}`);
  }
  for (const rule of ["AGENTS.md", ".env*", ".npmrc", ".netrc", ".data", "docker-data", "*.db", "*.db-*", "*.sqlite3-*", "*.key", ".ssh"]) {
    assert.ok(dockerRules.has(rule), `.dockerignore 缺少 ${rule}`);
  }
  assert.match(dockerfile, /COPY \. \./u, "Dockerfile 构建方式改变后应重新审计上下文边界");
});

check("公开说明明确部署、数据持久化和隐私边界", async () => {
  const readme = await source("README.md");
  assert.match(readme, /新机器首次部署使用 `git clone`/u);
  assert.match(readme, /已有工作副本更新时才使用 `git pull --ff-only`/u);
  assert.match(readme, /运行数据保存在 `docker-data\/v2\/`/u);
  assert.match(readme, /军团收藏使用当前浏览器的本地存储/u);
  assert.match(readme, /不等同于用户身份认证/u);
  assert.match(readme, /不能直接替代 Docker 部署/u);
});
