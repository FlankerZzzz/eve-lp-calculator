const ADMIN_HEADER = "x-sync-admin-token";

function safeEqual(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function configured(name: "SYNC_ADMIN_TOKEN") {
  return (process.env[name] || "").trim();
}

export function authorizeSyncControl(request: Request) {
  const admin = configured("SYNC_ADMIN_TOKEN");
  if (!admin) return null;
  const supplied = request.headers.get(ADMIN_HEADER) || "";
  if (!safeEqual(supplied, admin)) return Response.json({ error: "同步管理口令无效" }, { status: 403 });
  return null;
}
