import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { fileURLToPath } from "node:url";
import { adminPageGuard, adminPageRouter, ADMIN_CSP } from "./adminPage.js";

const ADMIN_DIR = fileURLToPath(new URL("../../../admin/", import.meta.url));

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function runGuard(remoteAddress) {
  const headers = {};
  let status = 0;
  let body = "";
  let next = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    type() {
      return this;
    },
    send(value) {
      body = value;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  adminPageGuard({ socket: { remoteAddress } }, res, () => {
    next = true;
  });
  return { status, body, next, headers };
}

test("the admin page opens to the machine and its intranet, not to the public", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.10", "::ffff:192.168.1.10", "fd00::7"]) {
    const result = runGuard(address);
    assert.equal(result.next, true, address);
    assert.equal(result.headers["Content-Security-Policy"], ADMIN_CSP);
    assert.equal(result.headers["X-Frame-Options"], "DENY");
  }
  for (const address of ["203.0.113.9", "8.8.8.8", "2001:db8::1"]) {
    const remote = runGuard(address);
    assert.equal(remote.next, false, address);
    assert.equal(remote.status, 404);
    assert.equal(remote.body, "not_found");
    assert.equal(remote.headers["Content-Security-Policy"], undefined);
  }
});

test("the admin page serves its own files and falls through to 404", async () => {
  const app = express();
  app.use("/admin", adminPageRouter({ dir: ADMIN_DIR }));
  const server = await listen(app);
  try {
    const base = `http://127.0.0.1:${server.address().port}/admin`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") || "", /script-src 'self'/);
    assert.match(await page.text(), /Knot 管理后台/);

    const script = await fetch(`${base}/admin.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /TOKEN_KEY/);

    const missing = await fetch(`${base}/missing.js`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a release without the admin directory returns 404 instead of the public page", async () => {
  const app = express();
  app.use("/admin", adminPageRouter({ dir: "/definitely/not/here" }));
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "not_found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
