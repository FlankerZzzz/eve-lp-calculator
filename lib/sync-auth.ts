const INTERNAL_HEADER = "x-sync-internal-token";
const ADMIN_HEADER = "x-sync-admin-token";

function safeEqual(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function configured(name: "SYNC_INTERNAL_TOKEN" | "SYNC_ADMIN_TOKEN") {
  return (process.env[name] || "").trim();
}

export function authorizeInternalSync(request: Request) {
  const expected = configured("SYNC_INTERNAL_TOKEN");
  if (!expected) return Response.json({ error: "SYNC_INTERNAL_TOKEN 未配置，后台写入已安全停用" }, { status: 503 });
  const supplied = request.headers.get(INTERNAL_HEADER) || "";
  if (!safeEqual(supplied, expected)) return Response.json({ error: "后台同步凭据无效" }, { status: 403 });
  return null;
}

export function authorizeSyncControl(request: Request) {
  const internal = configured("SYNC_INTERNAL_TOKEN");
  if (internal && safeEqual(request.headers.get(INTERNAL_HEADER) || "", internal)) return null;
  const admin = configured("SYNC_ADMIN_TOKEN");
  if (!admin) return Response.json({ error: "SYNC_ADMIN_TOKEN 未配置，手动控制已安全停用" }, { status: 503 });
  const supplied = request.headers.get(ADMIN_HEADER) || "";
  if (!safeEqual(supplied, admin)) return Response.json({ error: "同步管理口令无效" }, { status: 403 });
  return null;
}
