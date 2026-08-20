import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_ROOT = process.env.ENTITY_ICON_CACHE_PATH || "/data/entity-icons";
const SERENITY_IMAGE_BASE = process.env.SERENITY_IMAGE_BASE_URL || "https://image.evepc.163.com";
const IMAGE_BASE = process.env.EVE_IMAGE_BASE_URL || "https://images.evetech.net";
const CACHE_VERSION = "v4";
const ALLOWED_SIZES = new Set([32, 64, 128, 256, 512, 1024]);
const SERENITY_DEFAULT_LOGO_HASHES = new Set([
  "6b15ee7621c4c41bdacbc57daf19b05d891179c27563653fbcc4d1b1765834ad",
  "2b0fe1aaf7a496e4d7f52f18af1db39327519a15a1d03bfa8c52f90e3696bcc6",
  "0e6896a4d4d0c1e0cb878f1cc479604857ae13031ec18e7a9779561d63130aae",
]);
const INTERNATIONAL_DEFAULT_LOGO_HASHES = new Set([
  "c478788022f41358794c3408d7a6e6391bfa71a547633d75442c3e82476d2ec2",
  "c518f9c9dc909a87dd6ade0c1b360190a86a9c7cb24894025e234e6917028d0f",
  "69085d8b736714a6dce6e19fdc74609559a8791f33e62a1b6dd7d199f5d31693",
  "32799a9858774741ac0608ba57fa6607bfd8d0b54f95257c174eaf5b55392b80",
  "11e48eeb3eb043e5fd807ef05157fa67d14b532aeafe1c0f3f38edeaf3930bbd",
  "a61ca1de93f689ce38b564cc77b2231dd8ef76dfd8f62052bd676c010c620378",
]);

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
  const fallbackFactionId = Number(url.searchParams.get("fallback_faction_id") || 0);
  const requestedSize = Number(url.searchParams.get("size") || 32);
  const size = ALLOWED_SIZES.has(requestedSize) ? requestedSize : 32;
  if ((kind !== "faction" && kind !== "corporation") || !Number.isSafeInteger(entityId) || entityId <= 0) {
    return imageResponse(fallbackSvg(size), "image/svg+xml; charset=utf-8", "fallback");
  }

  const refsDir = join(CACHE_ROOT, "refs");
  const blobsDir = join(CACHE_ROOT, "blobs");
  const refPath = join(refsDir, `${CACHE_VERSION}-${kind}-${entityId}-${size}-${fallbackFactionId}.json`);
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
        const sourceHash = createHash("sha256").update(fetched.body).digest("hex");
        if (SERENITY_DEFAULT_LOGO_HASHES.has(sourceHash)) throw new Error("Serenity returned its default corporation logo");
      } catch {
        networkSource = "network-intl";
        try {
          fetched = await requestImage(`${IMAGE_BASE.replace(/\/$/, "")}/corporations/${entityId}/logo?size=${size}`);
          const sourceHash = createHash("sha256").update(fetched.body).digest("hex");
          if (INTERNATIONAL_DEFAULT_LOGO_HASHES.has(sourceHash)) throw new Error("Tranquility returned its default corporation logo");
        } catch {
          if (!Number.isSafeInteger(fallbackFactionId) || fallbackFactionId <= 0) throw new Error("corporation has no usable logo");
          networkSource = "network-faction-fallback";
          fetched = await requestImage(`${IMAGE_BASE.replace(/\/$/, "")}/corporations/${fallbackFactionId}/logo?size=${size}`);
        }
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
