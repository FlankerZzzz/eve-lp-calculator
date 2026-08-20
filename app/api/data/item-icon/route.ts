import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_ROOT = process.env.ITEM_ICON_CACHE_PATH || "/data/item-icons";
const IMAGE_BASE = process.env.EVE_IMAGE_BASE_URL || "https://images.evetech.net";
const ALLOWED_SIZES = new Set([32, 64, 128, 256, 512, 1024]);

type CacheRef = { hash: string; contentType: string };

const fallbackSvg = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" rx="6" fill="#131b21"/><path d="M20 18h24v28H20z" fill="none" stroke="#53626d" stroke-width="2"/><path d="M25 27h14M25 33h14M25 39h9" stroke="#53626d" stroke-width="2"/><circle cx="42" cy="43" r="8" fill="#172a25" stroke="#55e6bd" stroke-width="2"/><path d="M42 39v8M38 43h8" stroke="#55e6bd" stroke-width="2"/></svg>`;

const imageResponse = (body: BodyInit, contentType: string, source: string) => new Response(body, {
  headers: {
    "content-type": contentType,
    "cache-control": source === "fallback" ? "public, max-age=300" : "public, max-age=604800, immutable",
    "x-item-icon-source": source,
  },
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const typeId = Number(url.searchParams.get("type_id"));
  const requestedSize = Number(url.searchParams.get("size") || 64);
  const size = ALLOWED_SIZES.has(requestedSize) ? requestedSize : 64;
  if (!Number.isSafeInteger(typeId) || typeId <= 0) return imageResponse(fallbackSvg(size), "image/svg+xml; charset=utf-8", "fallback");

  const refsDir = join(CACHE_ROOT, "refs");
  const blobsDir = join(CACHE_ROOT, "blobs");
  const refPath = join(refsDir, `${typeId}-${size}.json`);
  try {
    const ref = JSON.parse(await readFile(refPath, "utf8")) as CacheRef;
    const cached = await readFile(join(blobsDir, ref.hash));
    return imageResponse(cached, ref.contentType, "disk");
  } catch {
    // Cache miss or incomplete cache entry; fetch and repair below.
  }

  try {
    const response = await fetch(`${IMAGE_BASE.replace(/\/$/, "")}/types/${typeId}/icon?size=${size}`, {
      headers: { accept: "image/avif,image/webp,image/png,image/*" },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("image/")) throw new Error(`image service HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) throw new Error("empty image response");

    const extension = contentType.includes("webp") ? ".webp" : contentType.includes("avif") ? ".avif" : ".png";
    const hash = `${createHash("sha256").update(body).digest("hex")}${extension}`;
    await Promise.all([mkdir(refsDir, { recursive: true }), mkdir(blobsDir, { recursive: true })]);
    try { await writeFile(join(blobsDir, hash), body, { flag: "wx" }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const temporaryRef = `${refPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryRef, JSON.stringify({ hash, contentType } satisfies CacheRef));
    await rename(temporaryRef, refPath);
    return imageResponse(body, contentType, "network");
  } catch {
    return imageResponse(fallbackSvg(size), "image/svg+xml; charset=utf-8", "fallback");
  }
}
