# 站点档案 · 签发区与自述区

一份站点档案分成两块，写在两处，谁也不能替对方写：

| 区 | 写什么 | 存在哪 | 谁写 |
|----|--------|--------|------|
| **签发区** | `id`、`url`、`since`、`tier`、`status` | `sites/<站点>/xknot.env`（中枢签发的接入件） | 中枢 |
| **自述区** | 名称、一句话介绍、详细介绍、logo、主理人、联系方式、地区、时区、标签 | `sites/<站点>/profile.json` | 主理人，在 `/admin` 里编辑 |

合起来就是 `GET /api/federation/profile` 返回的那一份，也是中枢取回去展示的输入。中枢侧怎么取、怎么缓存，见 [联邦契约](../../xknot.si/docs/FEDERATION.md)。

![站点档案的两块](profile-sections.svg)

## 1. 为什么分成两块

- **签发区**是中枢对外的承诺：这个 id 归谁、地址是什么、什么时候接入、验收状态。节点改它会和中枢清单对不上，所以只读。
- **自述区**是主理人的表达：叫什么、怎么介绍自己、怎么联系。改它不需要任何人批准，也不该走邮件审批。名字换了、联系方式换了，主理人自己在 `/admin` 保存一次就生效，中枢下次取回时换掉。

## 2. 文件

```json
{
  "formatVersion": 2,
  "updatedAt": "2026-10-21",
  "site": {
    "name": "XKnot创世启元",
    "locale": "zh-CN",
    "tagline": "面向 AI 时代、服务于 Agent 的信息交换网。",
    "intro": "一个站点，收发一手情报……",
    "logo": "https://wang.xknot.si/logo.png",
    "owner": "PaulWang",
    "contact": "owner@example.com",
    "region": "CN",
    "timezone": "Asia/Shanghai",
    "tags": ["信息交换", "Agent"]
  }
}
```

- 位置由部署脚本写进 `KNOT_PROFILE_FILE`：`<部署根>/sites/<站点>/profile.json`。没有这个值时不写档案，`/admin` 会说明。
- 文件不存在不是错误：站点可以一直不填，本站用兜底文案，门户只显示 id。
- 写入是整份替换：先校验，全过才落盘；任何一项不合格一个字节都不写。

## 3. 字段

十项，全是扁平值，**没有多语种文案映射**：主理人填什么，本站就显示什么，中枢原样取回。文案用哪个语种由主理人自己决定，系统不折中、不翻译、不回落。唯一的语种字段是 `locale`：它不描述文案，描述**界面**——访客第一次打开时 WebUI 用什么语言。

| 字段 | 类型 | 上限 | 必填 | 说明 |
|------|------|------|------|------|
| `name` | 字符串 | 40 | 是 | 站点名。顶栏、浏览器标题、门户卡片 |
| `locale` | `zh-CN` / `zh-TW` / `en` | — | 是（`/admin` 强制） | 站点默认界面语言。访客自己选过语种就按他的选择，没选过时按这一项。也是向中枢申请时通信邮件用的语种 |
| `tagline` | 字符串 | 60 | 否 | 一句话介绍。未登录首页、门户卡片 |
| `intro` | 字符串 | 800 | 否 | 详细介绍。点开站点介绍后展开 |
| `logo` | https 地址 | 300 | 否 | 绝对地址；站内相对路径不接受 |
| `owner` | 字符串 | 40 | 否 | 主理人的称呼 |
| `contact` | 字符串 | 120 | 否 | 公开联系方式，邮箱或 https 地址 |
| `region` | 两位国家码或 `GLOBAL` | 2 | 否 | 门户按它分区域；小写会被转成大写 |
| `timezone` | IANA 名 | 40 | 否 | 如 `Asia/Shanghai`，认不出就拒 |
| `tags` | 字符串数组 | 9 个，每个 16 | 否 | 自由文本，不翻译、不排序、忽略大小写去重 |

`region` 与 `timezone` 只在中枢门户上用：本站界面不显示地区，时区只用于门户卡片上的当地钟点。`region` 是**机器所在地**，不决定界面语言，也不决定文案语种。`tags` 同理，只出现在门户卡片与筛选里。

`locale` 在接口层是可选：旧档案还没有这一项时要能读、能取回，缺省按 `zh-CN`；`/admin` 每次保存都会带上它，所以新写的档案一定有。写错取值（`ja`、空串以外的东西）会让整份档案被拒。

空的字符串不要写：要清掉一项就整键省略。不认识的键会被拒。

## 4. 接口

| 方法 | 路径 | 谁用 | 说明 |
|------|------|------|------|
| GET | `/api/federation/profile` | 中枢、任何访客 | 公开、无需会话。返回 `{ formatVersion, issued, site, updatedAt }`；自述区原样在 `site` 里，与 `profile.json` 的 `site` 同构 |
| GET | `/api/admin/profile` | `/admin` | 同一份数据，另带 `file`（路径）与 `problems`（逐条问题） |
| PUT | `/api/admin/profile` | `/admin` | `{ site }` 整份替换；成功时回与 GET 相同的一份视图（含 `issued`），校验不过返回 400 `bad_profile` 和 `problems`；没有站点目录时返回 503 `profile_unconfigured` |
| GET | `/api/admin/xknot/subdomain?label=` | `/admin` | 把标签转发到中枢的 `GET /api/subdomains/check`，返回 `available`、`reason` 与候选建议 |
| POST | `/api/admin/xknot/apply` | `/admin` | 把自述与联系邮箱交给中枢的 `POST /api/applications`；中枢的状态码与 `fields` 原样带回。成功时另带 `key`：`{ delivered, created, error }`，说明顺手交上去的隧道公钥有没有被中枢收下 |
| GET | `/api/admin/xknot/application` | `/admin` | 本地底账：已交申请的编号、案例链接、状态与提交时间；没有记录时 `application` 为 `null` |

`POST /api/admin/xknot/apply` 成功后会把这四项写进与 `profile.json` 同级的 `join.json`（权限 `600`）。受理后同一个请求会生成（或复用）隧道密钥并把公钥交到案例页；这一步失败不回滚申请，响应里的 `key.delivered` 为 `false`，`key.error` 说明是生成失败还是中枢拒收。案例链接本身就是能力凭据，不进版本库、不进发布包；邮件只是同步通知，刷新页面后从「接入 XKnot」卡片还能打开进度。

`/api/web/session` 里的 `defaultLocale` 是 `site.locale`，档案里没有这一项时为 `zh-CN`；`brand` 是 `site` 的子集（名称、一句话介绍、长介绍、logo、主理人、联系方式），本站 WebUI 只用这六项。

`/api/federation/profile` 只读，不接受写入：主理人改档案只在本机 `/admin` 里做，中枢没有收件接口。

首页的 `title`、`description`、Open Graph 与 `<noscript>` 简介也来自这份档案，由 Backend 在每次返回 `index.html` 时按当前档案重写（[`backend/src/siteHtml.js`](../backend/src/siteHtml.js)），改完档案刷新即可，不用重新部署。

## 5. 在 /admin 里编辑

管理后台的 **外网访问** 栏分三块：

- **一 · XKnot 联邦**（先看这里）：一个状态徽标加一句话，说明现在到哪一步；旁边是这张单唯一的主按钮——没接入时是「申请加入」，卡住时是「重试」，入口侧就绪时是「接通并启动隧道」，申请作废时是「重新申请」。按钮下面是从头到尾的过程：自述区完整、提交申请、中枢的八个步骤、本机隧道、公网探测、接入件生效。失败的那一步写原因，按钮跟着原因走：能再点一次的和只能重交一张的，不混在一起。
- **二 · 本站点怎么介绍自己**（可编辑）：十个字段，名称必填，其余可空；「默认语种」是下拉框，只有简中、繁中、英文三项。改完点「保存档案」。校验不过时逐条显示在表单下面，一个字节都不写。地区、时区、标签下面标了「只在 xknot.si 上显示」。
- **三 · 中枢签发了什么**（只读）：id、地址、接入日、档位、状态，来自接入件；末尾一行说明这份自述公开在 `/api/federation/profile`。

申请表单只在主按钮是「申请加入」或「重新申请」时展开：二级域名输入框带 `.xknot.si` 后缀与「检查」按钮，右侧是联系邮箱，最后是「提交申请」。检查不通时按钮不可点，并把原因写回输入框下面——不让人填完一整页才发现签不了。提交的内容就是上面那份自述，所以改完要先保存档案。

二级域名由本站点代为向中枢问一次，不自己判：`GET /api/admin/xknot/subdomain?label=` 转发到中枢的 `GET /api/subdomains/check`，原样带回 `available`、`reason` 与候选建议。少于 6 位的标签中枢不签——短号留着以后用，第一条规则就写在输入框下面，不让它成为提交后的意外。

`POST /api/admin/xknot/apply` 把自述与邮箱交给中枢的 `POST /api/applications`。中枢的 400（带 `fields`）与 409（同址重复）原样回到这一块，不做本地改写。提交即通过（`reviewed_by` 记 `auto`），没有人工审核；已是成员的，中枢直接回执成功。

排障信息（接入件路径与权限、委托发信、探测地址、状态信号、接入件与进程的漂移）收在页面最下面的折叠栏「接入与探测」里，默认收起，展开时才请求 `/api/admin/federation`。
