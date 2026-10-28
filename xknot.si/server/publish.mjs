// 申请通过之后，把实例写进 instances.json 与 federation.json。
//
// 与 `admin-cli publish` 是同一套规则（server/manifest.mjs 生成、两份校验器把关），
// 区别只有两点：这里不打印、不退出，而且幂等 —— 已经有同一个地址或同一个 id 就跳过。
// 自动接通会重试同一张单，不能每重试一次就往清单里多塞一条。

import { readFile, rename, writeFile } from "node:fs/promises";

import { validateRoster } from "../ops/validate-federation.mjs";
import { withFileLock } from "./file-lock.mjs";
import { checkManifestEntry, nextVersion, toManifestEntry, toRosterMember } from "./manifest.mjs";

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${label}: ${error.message}`);
  }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/**
 * 幂等发布：清单缺条目就补，名册缺成员就补；缺一半时补齐另一半。
 *
 * @returns {{ error: string } | { entry: object, skipped: boolean }}
 */
export async function publishInstance({
  application,
  tunnelAccount,
  tunnelPort,
  manifestFile,
  rosterFile,
  write = writeJsonAtomic,
}) {
  const entry = toManifestEntry(application);
  const problems = checkManifestEntry(entry);
  if (problems.length) return { error: "invalid_entry", details: problems };

  // 读与写之间必须有锁：控制台保存、admin-cli publish 也在改同一份清单，
  // 交错时会各自把自己读到的旧副本写回去，前一个刚加的条目就丢了。
  return withFileLock(manifestFile, () =>
    publishLocked({ entry, tunnelAccount, tunnelPort, manifestFile, rosterFile, write })
  );
}

async function publishLocked({ entry, tunnelAccount, tunnelPort, manifestFile, rosterFile, write }) {
  const manifest = (await readJson(manifestFile, "instances.json")) || { version: 1, instances: [] };
  if (!Array.isArray(manifest.instances)) return { error: "manifest_unreadable" };

  const sameUrl = manifest.instances.find((item) => item.url === entry.url);
  const sameId = manifest.instances.find((item) => item.id === entry.id);
  if (sameUrl && sameUrl.id !== entry.id) return { error: "url_taken" };
  if (sameId && sameId.url !== entry.url) return { error: "id_taken" };

  const roster = (await readJson(rosterFile, "federation.json")) || { version: 1, members: [] };
  if (!Array.isArray(roster.members)) return { error: "roster_unreadable" };

  const member = roster.members.find((item) => item.id === entry.id);
  const today = new Date().toISOString().slice(0, 10);
  // version 记的是「清单被改过几次」：真加了一条就 +1，重复发布不动它。
  const nextManifest = sameId
    ? { ...manifest, updatedAt: today }
    : {
        ...manifest,
        version: nextVersion(manifest.version),
        updatedAt: today,
        instances: [...manifest.instances, entry],
      };

  let nextRoster = roster;
  if (!member) {
    nextRoster = {
      ...roster,
      updatedAt: new Date().toISOString().slice(0, 10),
      members: [
        ...roster.members,
        toRosterMember(entry, { tunnelAccount, tunnelPort }),
      ],
    };
    const problems = validateRoster(nextRoster, nextManifest);
    if (problems.length) return { error: "roster_invalid", details: problems };
  }

  // 两份都通过校验才落盘；名册先写，清单后写，中途失败最多是多一条待接通的名册条目，
  // 不会出现「清单里有、名册里没有」的悬挂状态（那是校验器直接判错的那一种）。
  if (!member) await write(rosterFile, nextRoster);
  if (!sameId) {
    try {
      await write(manifestFile, nextManifest);
    } catch (error) {
      // 清单是「对外可见」那一份，写失败时把名册回滚到原值，两边一起回到改动前，
      // 不留下「名册有、清单无」。回滚失败也只能让它跟着抛，主流程照常报错。
      if (!member) await write(rosterFile, roster);
      throw error;
    }
  }

  return {
    entry: nextManifest.instances.find((item) => item.id === entry.id),
    skipped: Boolean(sameId && member),
  };
}

/** 验收通过：把清单里的这一条从 pending 改成 active。 */
export async function markActive({ manifestFile, id }) {
  // 和发布同一个写者队列：worker 每轮都会调这里，没有锁时它会与控制台保存
  // 交错，把对方刚写进去的条目盖掉。
  return withFileLock(manifestFile, () => markActiveLocked({ manifestFile, id }));
}

// 发布时写进名册的那句话。验收之后它就成了假话——节点早接通了，名册还写着
// 「等待接通验收」，运营在总览里看到的就是一条尾巴。
export const ROSTER_PENDING_NOTE = "子域与隧道已登记，等待接通验收。";

/**
 * 验收通过：把名册里那条的「等待接通验收」换成「已接通」。
 *
 * 只改这一句默认话。运营手写过的备注一律不动——那是有判断的内容，
 * 不该被一次状态迁移盖掉。
 *
 * 锁按**清单**文件取，不用名册自己的锁：publishInstance、admin-cli publish、
 * 配置保存都是「先拿清单的锁，再写名册」。这里若另开一把名册锁，两把锁互不
 * 排斥，读 - 改 - 写就会交错，把刚发布的成员或刚换的备注盖掉。
 */
export async function markRosterLive({ manifestFile, rosterFile, id, now = new Date() }) {
  if (!manifestFile) return { error: "lock_file_required" };
  return withFileLock(manifestFile, async () => {
    const roster = await readJson(rosterFile, "federation.json");
    if (!roster || !Array.isArray(roster.members)) return { error: "roster_unreadable" };
    const member = roster.members.find((item) => item.id === id);
    if (!member) return { error: "not_listed" };
    if (member.note !== ROSTER_PENDING_NOTE) return { ok: true, changed: false };
    member.note = `已接通，门户已收录（${now.toISOString().slice(0, 10)}）。`;
    roster.updatedAt = now.toISOString().slice(0, 10);
    await writeJsonAtomic(rosterFile, roster);
    return { ok: true, changed: true };
  });
}

async function markActiveLocked({ manifestFile, id }) {
  const manifest = await readJson(manifestFile, "instances.json");
  if (!manifest || !Array.isArray(manifest.instances)) return { error: "manifest_unreadable" };
  const instance = manifest.instances.find((item) => item.id === id);
  if (!instance) return { error: "not_listed" };
  if (instance.status === "active") return { ok: true, changed: false };
  // 只从 pending 迁入。suspended / retired 是运营在清单上做的决定，
  // 而 worker 每一轮都会调用这里：不判前态就等于每轮把暂停与下架改回 active。
  if (instance.status !== "pending") return { error: "not_pending", status: instance.status };
  instance.status = "active";
  manifest.updatedAt = new Date().toISOString().slice(0, 10);
  manifest.version = nextVersion(manifest.version);
  await writeJsonAtomic(manifestFile, manifest);
  return { ok: true, changed: true };
}
