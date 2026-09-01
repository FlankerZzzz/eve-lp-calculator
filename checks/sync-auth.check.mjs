import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInternalSync, authorizeSyncControl } from "../lib/sync-auth.ts";

const request = headers => new Request("http://localhost/api/sync/control", { method: "POST", headers });

test("后台同步写入只接受内部凭据", () => {
  const previous = process.env.SYNC_INTERNAL_TOKEN;
  process.env.SYNC_INTERNAL_TOKEN = "internal-test-token";
  try {
    assert.equal(authorizeInternalSync(request({})).status, 403);
    assert.equal(authorizeInternalSync(request({ "x-sync-internal-token": "wrong" })).status, 403);
    assert.equal(authorizeInternalSync(request({ "x-sync-internal-token": "internal-test-token" })), null);
  } finally {
    if (previous === undefined) delete process.env.SYNC_INTERNAL_TOKEN;
    else process.env.SYNC_INTERNAL_TOKEN = previous;
  }
});

test("手动同步控制需要管理员口令，后台凭据仍可调度", () => {
  const previousAdmin = process.env.SYNC_ADMIN_TOKEN;
  const previousInternal = process.env.SYNC_INTERNAL_TOKEN;
  process.env.SYNC_ADMIN_TOKEN = "admin-test-token";
  process.env.SYNC_INTERNAL_TOKEN = "internal-test-token";
  try {
    assert.equal(authorizeSyncControl(request({ "x-sync-admin-token": "wrong" })).status, 403);
    assert.equal(authorizeSyncControl(request({ "x-sync-admin-token": "admin-test-token" })), null);
    assert.equal(authorizeSyncControl(request({ "x-sync-internal-token": "internal-test-token" })), null);
  } finally {
    if (previousAdmin === undefined) delete process.env.SYNC_ADMIN_TOKEN;
    else process.env.SYNC_ADMIN_TOKEN = previousAdmin;
    if (previousInternal === undefined) delete process.env.SYNC_INTERNAL_TOKEN;
    else process.env.SYNC_INTERNAL_TOKEN = previousInternal;
  }
});
