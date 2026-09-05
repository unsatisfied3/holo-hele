import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticSite } from "./static-site";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "holo-static-"));
  await mkdir(join(directory, "assets"));
  await Bun.write(join(directory, "index.html"), "<!doctype html><title>Holo Hele</title>");
  await Bun.write(join(directory, "assets", "app-test.js"), "console.log('demo');");
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function request(path: string, method = "GET") {
  return new Request(`http://localhost${path}`, {
    method, headers: { Accept: "text/html" },
  });
}

describe("production website hosting", () => {
  test("loads the app shell when a nested browser route is refreshed", async () => {
    const response = await serveStaticSite(request("/stops/437"), directory);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(await response.text()).toContain("Holo Hele");
  });
  test("serves built assets with their MIME type and immutable cache", async () => {
    const response = await serveStaticSite(request("/assets/app-test.js"), directory);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("javascript");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });
  test("HEAD returns headers without the asset body", async () => {
    const response = await serveStaticSite(request("/assets/app-test.js", "HEAD"), directory);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
  test("missing assets never receive the HTML app shell", async () => {
    expect((await serveStaticSite(request("/assets/missing.js"), directory)).status).toBe(404);
  });
  test("rejects hidden files, encoded traversal, backslashes, and malformed encoding", async () => {
    for (const path of ["/.env", "/%2e%2e%2fsecret", "/assets/%5csecret", "/%00"]) {
      expect((await serveStaticSite(request(path), directory)).status).toBe(404);
    }
    expect((await serveStaticSite(request("/%ZZ"), directory)).status).toBe(400);
  });
});
