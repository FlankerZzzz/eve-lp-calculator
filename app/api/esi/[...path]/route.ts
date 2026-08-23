import { NextRequest } from "next/server";

const ESI_BASE = process.env.ESI_BASE_URL || "https://ali-esi.evepc.163.com";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${ESI_BASE.replace(/\/$/, "")}/${path.join("/")}${request.nextUrl.search}`;
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: { accept: "application/json", "content-type": request.headers.get("content-type") || "application/json", "user-agent": "LP-Calculator/local" },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      cache: "no-store",
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json({ error: "ESI unavailable", detail: String(error) }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
