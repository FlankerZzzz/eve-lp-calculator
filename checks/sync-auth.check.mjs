import assert from "node:assert/strict";
import test from "node:test";
import { authorizeSyncControl } from "../lib/sync-auth.ts";

const request = headers => new Request("http://localhost/api/sync/control", { method: "POST", headers });


test("手动同步控制需要管理员口令，旧后台凭据不能绕过", () => {
  const previousAdmin = process.env.SYNC_ADMIN_TOKEN;
  const previousInternal = process.env.SYNC_INTERNAL_TOKEN;
  process.env.SYNC_ADMIN_TOKEN = "admin-test-token";
  process.env.SYNC_INTERNAL_TOKEN = "internal-test-token";
  try {
    assert.equal(authorizeSyncControl(request({ "x-sync-admin-token": "wrong" })).status, 403);
    assert.equal(authorizeSyncControl(request({ "x-sync-admin-token": "admin-test-token" })), null);
    assert.equal(authorizeSyncControl(request({ "x-sync-internal-token": "internal-test-token" })).status, 403);
  } finally {
    if (previousAdmin === undefined) delete process.env.SYNC_ADMIN_TOKEN;
    else process.env.SYNC_ADMIN_TOKEN = previousAdmin;
    if (previousInternal === undefined) delete process.env.SYNC_INTERNAL_TOKEN;
    else process.env.SYNC_INTERNAL_TOKEN = previousInternal;
  }
});
