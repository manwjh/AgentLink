import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 「入口流量有没有被 VPN 隧道接管」只能靠网卡计数器判断，所以这里的重点不是
// 脚本能不能跑，而是它读的到底是不是字节数：按固定列取的时候，地址列为空的
// 链路行（utun 一类没有 MAC 的网卡）会让字段整体前移，$7/$10 取到的是 Opkts
// 和 Coll，两个都像模像样的整数，脚本不报错，只是把结论说反了。
//
// 下面用一个假的 netstat 喂真实形状的输出，把这件事钉死；再用本地 HTTP 服务
// 把「哪块网卡涨、结论是什么、退出码是多少」整条链跑一遍。

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "egress-check.sh");
const LIB = path.join(HERE, "lib", "net-counters.sh");

const HEADER = "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll";

// en1 带地址列（11 个字段），utun4 的链路行没有地址列（10 个字段）。
function netstatOutput({ en1Bytes, utunBytes }) {
  return [
    HEADER,
    `en1        1500  <Link#12>   fa:c8:50:94:af:33  100     0  ${en1Bytes}  200     0  23217694327     0`,
    `en1        1500  192.168.3     192.168.3.91    100     -  ${en1Bytes}  200     -  23217694327     -`,
    `utun4      1300  <Link#20>                       300     0  ${utunBytes}  400     0  267240464     0`,
    `utun4      1300  172.16.0.2/32 connectivity-ch   300     -  ${utunBytes}  400     -  267240464     -`,
  ].join("\n");
}

async function stubEnvironment({ growEn1 = 0, growUtun4 = 0 } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "knot-egress-stub-"));
  const bin = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);

  const state = path.join(dir, "calls");
  const netstat = [
    "#!/bin/sh",
    // 脚本一轮里读三次计数器：探测 netstat 可用、before、after。
    // 前两次给基准值，第三次才涨，差值才是这次请求带来的量。
    `n=0; [ -f "${state}" ] && n=$(cat "${state}")`,
    "n=$((n + 1))",
    `printf '%s' "$n" > "${state}"`,
    "add_en1=0",
    "add_utun=0",
    'if [ "$n" -ge 3 ]; then',
    `  add_en1=${growEn1}`,
    `  add_utun=${growUtun4}`,
    "fi",
    `cat <<EOF`,
    HEADER,
    `en1        1500  <Link#12>   fa:c8:50:94:af:33  100     0  $((15679963036 + add_en1))  200     0  23217694327     0`,
    `utun4      1300  <Link#20>                       300     0  $((458196756 + add_utun))  400     0  267240464     0`,
    "EOF",
  ].join("\n");

  await writeFile(path.join(bin, "netstat"), netstat);
  chmodSync(path.join(bin, "netstat"), 0o755);
  return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

// 一个只回固定字节的本地服务，让 curl 真的成功，好走到判断出口那一步。
async function localServer(bytes) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.alloc(bytes, 0x61));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/payload`, close: () => server.close() };
}

function runScript(args, env) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });
}

// 起本地服务的那两个用例必须用异步的：spawnSync 会卡住事件循环，同进程里的
// 服务就没机会 accept，curl 一直等到超时，看起来像「请求失败」。
function runScriptAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("--help 打出用法，退出码 0", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--url/);
  assert.match(result.stdout, /退出码/);
});

test("缺 --url 和超时不是数字都按用法错误退出", () => {
  const missing = runScript([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--url/);

  const badTimeout = runScript(["--url", "http://127.0.0.1:1/", "--timeout", "abc"]);
  assert.equal(badTimeout.status, 2);
  assert.match(badTimeout.stderr, /--timeout/);
});

test("脚本里没有写死的地址和端口", () => {
  // 注释里出现 127.0.0.1 是在解释 lo0，不是配置；只看会执行的行。
  const code = [SCRIPT, LIB]
    .map((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n"),
    )
    .join("\n");
  assert.doesNotMatch(code, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(code, /https?:\/\/[a-z0-9-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(code, /xknot\.si/i);
});

test("计数器取的是字节数，不是包数", async () => {
  const { bin } = await stubEnvironment();
  const fixture = path.join(bin, "..", "fixture.txt");
  await writeFile(fixture, netstatOutput({ en1Bytes: 1000, utunBytes: 2000 }));

  const stub = path.join(bin, "netstat");
  await writeFile(stub, `#!/bin/sh\ncat "${fixture}"\n`);
  chmodSync(stub, 0o755);

  const out = execFileSync("bash", ["-c", `source "${LIB}"; knot_iface_counters`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const lines = out.trim().split("\n");

  // 带地址列和不带地址列两种行都要取到同一组字节数；包数是 100/200/300/400，
  // 取错列时这里会出现那几个数。
  assert.deepEqual(lines, ["en1 1000 23217694327", "utun4 2000 267240464"]);
  assert.ok(!out.includes("Name"), "表头行不该被当成一块网卡");
});

test("隧道网卡和物理网卡分得开", () => {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `source "${LIB}"
for name in utun4 utun0 ipsec0 ppp0 tun0 tap1 lo0 en0 en1 eth0; do
  if knot_iface_is_tunnel "$name"; then echo "$name tunnel"; else echo "$name plain"; fi
done`,
    ],
    { encoding: "utf8" },
  );
  const verdict = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(" ")),
  );
  assert.equal(verdict.utun4, "tunnel");
  assert.equal(verdict.utun0, "tunnel");
  assert.equal(verdict.ipsec0, "tunnel");
  assert.equal(verdict.ppp0, "tunnel");
  assert.equal(verdict.tun0, "tunnel");
  assert.equal(verdict.tap1, "tunnel");
  assert.equal(verdict.en0, "plain");
  assert.equal(verdict.en1, "plain");
  assert.equal(verdict.lo0, "plain");
  assert.equal(verdict.eth0, "plain");
});

test("物理网卡涨字节时报走物理网卡，退出码 0", async () => {
  const server = await localServer(1024);
  try {
    const { env } = await stubEnvironment({ growEn1: 4096 });
    const result = await runScriptAsync(["--url", server.url], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /走物理网卡/);
    assert.match(result.stdout, /en1/);
  } finally {
    server.close();
  }
});

test("只有隧道网卡涨字节时报被接管，退出码 3", async () => {
  const server = await localServer(1024);
  try {
    const { env } = await stubEnvironment({ growUtun4: 4096 });
    const result = await runScriptAsync(["--url", server.url], env);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /流量进了 VPN 隧道/);
  } finally {
    server.close();
  }
});

test("请求失败时不拿重传数据下结论，退出码 1", async () => {
  const { env } = await stubEnvironment({ growEn1: 4096 });
  // 端口 1 上不会有服务在听，连接立即被拒。
  const result = runScript(["--url", "http://127.0.0.1:1/", "--timeout", "5"], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不作判断/);
});
