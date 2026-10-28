// 重新生成入口 conf 的期望文件。
//
// 只在**有意改变渲染结果**时运行，并且要把生成出来的差异一起提交审阅：
//   node server/fixtures/render-golden.mjs --write
//
// 平时的用法是 `node --test server/provision.golden.test.mjs`：渲染结果与
// fixtures 里那份逐字节比对，不一致就打印 unified diff。这是入口 conf 唯一的
// 回归证据——远端那次 `nginx -t` 只能说明「这份配置 nginx 认」，说明不了
// 「这份配置还是不是我们上次确认过的那一份」。

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderHttpVhost,
  renderPlaceholder,
  renderSshdMatch,
  renderVhost,
} from "../provision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = HERE;

// 一份固定输入，覆盖每一种渲染：签发阶段的 80、接通前的占位页、接通后的整站反代、
// 以及一个多成员的 sshd。域名用真实形状（含连字符与多级标签），端口用名册里的量级。
export const CASES = [
  {
    file: "http-stage.conf",
    render: () => renderHttpVhost({ domain: "cpswang.xknot.si", root: "/var/www/cpswang" }),
  },
  {
    file: "entry-proxied.conf",
    render: () =>
      renderVhost({ domain: "cpswang.xknot.si", root: "/var/www/cpswang", port: 18090, entry: true }),
  },
  {
    file: "entry-pending.conf",
    render: () =>
      renderVhost({ domain: "travel-sg.xknot.si", root: "/var/www/travel-sg", port: 18091 }),
  },
  {
    file: "placeholder.html",
    render: () => renderPlaceholder({ instanceId: "cpswang", name: "北港 & <示例>" }),
  },
  {
    file: "sshd-match.conf",
    render: () =>
      renderSshdMatch({
        members: [
          { role: "hub", tunnel: { account: "knot-tunnel", port: 18080 } },
          { role: "founding", tunnel: { account: "knot-tunnel-cpswang", port: 18090 } },
          { role: "partner", tunnel: { account: "knot-tunnel-travel-sg", port: 18091 } },
        ],
      }),
  },
];

export function goldenPath(file) {
  return path.join(GOLDEN_DIR, file);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const write = process.argv.includes("--write");
  for (const testCase of CASES) {
    const target = goldenPath(testCase.file);
    const rendered = testCase.render();
    if (!write) {
      let current = "";
      try {
        current = await readFile(target, "utf8");
      } catch {
        current = "";
      }
      console.log(`${testCase.file}: ${current === rendered ? "matches" : "DIFFERS"}`);
      continue;
    }
    await writeFile(target, rendered, "utf8");
    console.log(`wrote ${testCase.file} (${Buffer.byteLength(rendered, "utf8")} bytes)`);
  }
  if (!write) console.log("\nrun with --write to accept the current rendering");
}
