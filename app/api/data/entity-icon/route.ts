import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_ROOT = process.env.ENTITY_ICON_CACHE_PATH || "/data/entity-icons";
const SERENITY_IMAGE_BASE = process.env.SERENITY_IMAGE_BASE_URL || "https://image.evepc.163.com";
const IMAGE_BASE = process.env.EVE_IMAGE_BASE_URL || "https://images.evetech.net";
const CACHE_VERSION = "v2";
const ALLOWED_SIZES = new Set([32, 64, 128, 256, 512, 1024]);

type CacheRef = { hash: string; contentType: string };

const fallbackSvg = (size: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#131b21"/><circle cx="32" cy="24" r="9" fill="none" stroke="#53626d" stroke-width="2"/><path d="M16 49c3-10 10-15 16-15s13 5 16 15" fill="none" stroke="#55e6bd" stroke-width="2"/></svg>`;

const imageResponse = (body: BodyInit, contentType: string, source: string) => new Response(body, {
  headers: {
    "content-type": contentType,
    "cache-control": source === "fallback" ? "public, max-age=300" : "public, max-age=604800, immutable",
    "x-entity-icon-source": source,
  },
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const entityId = Number(url.searchParams.get("id"));
  const requestedSize = Number(url.searchParams.get("size") || 32);
  const size = ALLOWED_SIZES.has(requestedSize) ? requestedSize : 32;
  if ((kind !== "faction" && kind !== "corporation") || !Number.isSafeInteger(entityId) || entityId <= 0) {
    return imageResponse(fallbackSvg(size), "image/svg+xml; charset=utf-8", "fallback");
  }

  const refsDir = join(CACHE_ROOT, "refs");
  const blobsDir = join(CACHE_ROOT, "blobs");
  const refPath = join(refsDir, `${CACHE_VERSION}-${kind}-${entityId}-${size}.json`);
  try {
    const ref = JSON.parse(await readFile(refPath, "utf8")) as CacheRef;
    const cached = await readFile(join(blobsDir, ref.hash));
    return imageResponse(cached, ref.contentType, "disk");
  } catch {
    // Cache miss or incomplete cache entry; fetch and repair below.
  }

  const requestImage = async (imageUrl: string) => {
    const response = await fetch(imageUrl, {
      headers: { accept: "image/avif,image/webp,image/png,image/*" },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("image/")) throw new Error(`image service HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) throw new Error("empty image response");
    return { body, contentType };
  };

  try {
    let fetched: { body: Buffer; contentType: string };
    let networkSource: string;
    if (kind === "faction") {
      networkSource = "network-intl";
      try {
        fetched = await requestImage(`${IMAGE_BASE.replace(/\/$/, "")}/corporations/${entityId}/logo?size=${size}`);
      } catch {
        networkSource = "network-cn";
        fetched = await requestImage(`${SERENITY_IMAGE_BASE.replace(/\/$/, "")}/Corporation/${entityId}_${size}.png`);
      }
    } else {
      networkSource = "network-cn";
      try {
        fetched = await requestImage(`${SERENITY_IMAGE_BASE.replace(/\/$/, "")}/Corporation/${entityId}_${size}.png`);
      } catch {
        networkSource = "network-intl";
        fetched = await requestImage(`${IMAGE_BASE.replace(/\/$/, "")}/corporations/${entityId}/logo?size=${size}`);
      }
    }

    const { body, contentType } = fetched;
    const extension = contentType.includes("webp") ? ".webp" : contentType.includes("avif") ? ".avif" : ".png";
    const hash = `${createHash("sha256").update(body).digest("hex")}${extension}`;
    await Promise.all([mkdir(refsDir, { recursive: true }), mkdir(blobsDir, { recursive: true })]);
    try { await writeFile(join(blobsDir, hash), body, { flag: "wx" }); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const temporaryRef = `${refPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryRef, JSON.stringify({ hash, contentType } satisfies CacheRef));
    await rename(temporaryRef, refPath);
    return imageResponse(body, contentType, networkSource);
  } catch {
    return imageResponse(fallbackSvg(size), "image/svg+xml; charset=utf-8", "fallback");
  }
}
