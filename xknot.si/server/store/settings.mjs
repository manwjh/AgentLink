// 中枢自己的运行期开关，以及运营方的操作留痕。
//
// 两张表都没有业务规则：一张是「此刻按什么值跑」，一张是「谁在什么时候改过」。
// 放库里而不是配置文件，是为了改完立刻生效、多进程读同一份。

import { nowIso } from "./util.mjs";

export function createSettingsStore({ db, get, all, event }) {
  return {
    // 控制台自己的写操作也要留痕；内部 event() 只在库内使用。
    recordEvent(kind, ref, detail) {
      event(kind, ref, detail);
    },
    events(limit = 50) {
      return all("select * from events order by seq desc limit ?", Math.min(Number(limit) || 50, 200));
    },

    // 读不到就是 null，调用方自己决定「没有值时按什么算」。
    getSetting(key) {
      const row = get("select * from settings where key = ?", String(key || ""));
      return row ? { value: row.value, at: row.at, by: row.by || "" } : null;
    },

    // 写一行或删一行。value 传 null 就是删掉，回到环境变量给的默认值。
    setSetting(key, value, by = null) {
      const name = String(key || "").trim();
      if (!/^[a-z][a-z0-9_.-]{0,40}$/.test(name)) return { error: "invalid_key" };
      if (value === null || value === undefined) {
        db.prepare("delete from settings where key = ?").run(name);
        event("setting.cleared", name, by || "");
        return { key: name, value: null };
      }
      const text = String(value);
      const at = nowIso();
      db.prepare(
        `insert into settings (key, value, at, by) values (?, ?, ?, ?)
         on conflict(key) do update set value = excluded.value, at = excluded.at, by = excluded.by`
      ).run(name, text, at, by);
      event("setting.changed", name, text);
      return { key: name, value: text, at, by: by || "" };
    },
  };
}
