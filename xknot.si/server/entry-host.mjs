// 入口主机上的最小操作面：sudo、读、写、解析。
//
// 只走参数数组，不经 shell 拼串：文件名、域名的某些部分最终来自清单与名册，
// 那是一份外部输入。写入一律先落同目录的临时文件再 rename —— nginx 随时可能在
// 读这个路径，原地截断写会让它读到半份内容。
//
// 开通 worker 与命令行共用这一份：两边对「怎么写文件」「谁的权限」必须是同一套
// 规矩，各写一份迟早分叉，而分叉的症状是线上 conf 权限悄悄变宽。

import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";

import { ProvisionError } from "./provision.mjs";

export function sudo(argv, { input = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-n", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function createEntryHost({ run = sudo } = {}) {
  return {
    sudo: run,
    async readRootFile(file) {
      const result = await run(["cat", file]);
      return result.code === 0 ? result.stdout : null;
    },
    async writeRootFile(file, text, mode = "644", { owner = null } = {}) {
      // 先 tee 再 chmod 的话，600 的目标会有一小段时间按 tee 的 umask 落在 644，
      // 凭据文件在那个窗口里是他人可读的。让远端 shell 自己设 umask，文件从创建起就收紧；
      // 文件名作为位置参数传给 sh，不拼进命令串。
      const written = await run(["sh", "-c", 'umask 077; cat > "$0"', file], { input: text });
      if (written.code !== 0) throw new ProvisionError("write_failed", written.stderr);
      if (owner) await run(["chown", owner, file]);
      await run(["chmod", mode, file]);
    },
    // 公开文件：先写同目录的临时文件，再 rename 到位。
    async writeEntryFile(file, text) {
      const written = await run(
        ["sh", "-c", 'tmp="$1.tmp.$$"; umask 022; cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"', "sh", file],
        { input: text }
      );
      if (written.code !== 0) throw new Error(written.stderr.trim() || "write_failed");
    },
    // 实例不再提供快照时把磁盘上那份删掉，让 nginx 的 try_files 回落到隧道：
    // 留在那里的旧快照会一直发一份实例已经不再承认的内容。
    async removeEntryFile(file) {
      const removed = await run(["rm", "-f", file]);
      if (removed.code !== 0) throw new Error(removed.stderr.trim() || "remove_failed");
    },
    async resolve4(hostname) {
      try {
        return await dns.resolve4(hostname);
      } catch {
        return [];
      }
    },
    // 探测走 fetch-guard 时要一份「全部地址」：只查 A 记录会漏掉只有 AAAA 的实例，
    // 也会让地址校验拿不到完整的解析结果。
    async resolveAll(hostname) {
      const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
      const addresses = [];
      for (const item of settled) {
        if (item.status === "fulfilled") addresses.push(...item.value);
      }
      return addresses;
    },
  };
}
