import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchJson } from "./cdp.js";

let server: http.Server | undefined;

describe("fetchJson", () => {
  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  });

  it("returns a clear timeout when CDP HTTP discovery hangs", async () => {
    server = http.createServer(() => {
      // Intentionally leave the request open.
    });
    await listen(server);

    await expect(fetchJson(`http://127.0.0.1:${port(server)}`, "/json/version"))
      .rejects.toThrow("CDP endpoint /json/version timed out after 3000ms.");
  });

  it("returns a clear HTTP status error when discovery is not exposed", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404, { "content-length": "0" });
      res.end();
    });
    await listen(server);

    await expect(fetchJson(`http://127.0.0.1:${port(server)}`, "/json/version"))
      .rejects.toThrow("CDP endpoint /json/version returned 404 Not Found");
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function port(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server is not listening");
  return address.port;
}
