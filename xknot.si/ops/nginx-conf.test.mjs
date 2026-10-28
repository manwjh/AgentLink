import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 门户是纯静态站，gzip 只能在 nginx 里开：这份 conf 就是唯一的地方。
// 关掉它，154KB 的主包会按原文发给每一个访客，而且不会报任何错。

const conf = readFileSync(fileURLToPath(new URL("./xknot.si.conf", import.meta.url)), "utf8");

test("中枢门户的 nginx 打开 gzip，且只压文本类", () => {
  assert.match(conf, /^\s*gzip on;$/m);
  assert.match(conf, /^\s*gzip_vary on;$/m);
  assert.match(conf, /^\s*gzip_proxied any;$/m);
  assert.match(conf, /gzip_types[^;]*application\/javascript/);
  assert.match(conf, /gzip_types[^;]*text\/css/);
  assert.match(conf, /gzip_types[^;]*application\/json/);
  // Agent 指引的原文走 text/markdown，不列进来就一点不压。
  assert.match(conf, /gzip_types[^;]*text\/markdown/);
  // 图片与字体已经压过，不要再走一遍。
  assert.doesNotMatch(conf, /gzip_types[^;]*image\/(jpeg|png)/);
});

// 门户自己的流量必须和实例子域写进同一份按 $host 分桶的 JSON 日志。
// 落到默认的 main 格式（不记 $host）就分不出来，hub.json 永远不生成，
// 而聚合任务会「成功」退出、只是少一块数据，不会有任何报错。
test("门户与实例子域共用按 host 分桶的访问日志", () => {
  assert.match(conf, /^\s*access_log \/var\/log\/nginx\/knot-access\.log knot_json_hub;$/m);
  // 格式必须在这份 conf 里声明，不能引用别处装的文件：少一次安装步骤，
  // 少一处跨项目的隐式依赖。聚合端按这些键读，少一个键就少一列。
  assert.match(conf, /^log_format knot_json_hub escape=json$/m);
  // 名字按 vhost 唯一：与子域的 knot_json_<子域> 不重名，同一台入口主机上
  // 不会出现 log_format 重复声明。
  assert.deepEqual(conf.match(/^log_format .*$/gm), ["log_format knot_json_hub escape=json"]);
  const start = conf.indexOf("log_format knot_json_hub");
  const format = conf.slice(start, conf.indexOf("}';", start));
  for (const key of ["at", "host", "status", "method", "uri", "bytes", "requestTime", "upstreamTime", "cache", "ip", "ua", "ref"]) {
    assert.match(format, new RegExp(`"${key}":`), `日志格式缺 ${key}`);
  }
  // 查询串里可能带分享令牌与搜索词，不进日志。
  assert.doesNotMatch(format, /\$request_uri|\$args/);
});

test("Agent 指引有两条静态地址：HTML 给浏览器，原文给 Agent", () => {
  // 两个都是磁盘上的文件，不能回源、不能落到 SPA 的 location /。
  assert.match(conf, /location = \/knot-help \{\s*try_files \/knot-help\.html =404;/);
  assert.match(conf, /location = \/knot-help\.md \{\s*default_type text\/markdown;/);
  // 文档会随实例策略改，别让它按一年缓存住。
  assert.doesNotMatch(conf, /location = \/knot-help[^}]*immutable/s);
});

// 根路径曾经直接 302 到 /en/，那张跳转页就永远送不出去：Search Console 验证
// 网址前缀时抓的是根路径，标签必须从这一页自己出来，不能指望抓取器先跳一次。
test("根路径直接送出跳转页，不是 302", () => {
  assert.match(conf, /location = \/\s*\{\s*try_files \/index\.html =404;/);
  assert.doesNotMatch(conf, /location = \/\s*\{\s*return 30[12] /);
  // 换验证令牌后要立刻可见，不能按长缓存发。
  assert.match(conf, /location = \/\s*\{[^}]*expires -1;/s);
});
