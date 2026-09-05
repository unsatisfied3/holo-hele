import { extname, resolve } from "node:path";

/** Serve only the build directory; browser routes fall back to the app shell. */
export async function serveStaticSite(
  request: Request,
  directory: string,
): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  if (
    pathname.includes("\\") || pathname.includes("\0") ||
    pathname.split("/").some((part) => part.startsWith("."))
  ) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(resolve(directory, `.${pathname}`));
  if (pathname !== "/" && await file.exists()) {
    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        "Content-Type": file.type,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  }

  if (extname(pathname) || !request.headers.get("Accept")?.includes("text/html")) {
    return new Response("Not found", { status: 404 });
  }

  const index = Bun.file(resolve(directory, "index.html"));
  if (!await index.exists()) {
    return new Response("Website build unavailable", { status: 503 });
  }
  return new Response(request.method === "HEAD" ? null : index, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
