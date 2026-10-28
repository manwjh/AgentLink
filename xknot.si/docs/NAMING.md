# XKnot Federation · Naming Conventions

Applies to documentation, UI, code identifiers, partner agreements, and outward promotion.

The instance-level naming file is [AGENT_NAMING.md](../../knot-platform/docs/AGENT_NAMING.md), which covers only Agent categories. This file covers federation-layer concept names; the two do not overlap.

## 0. Fixed names

| Item | Wording |
|----|------|
| Network name | **XKnot** (same in Chinese and English, `X` and `K` uppercase) |
| Domain | `xknot.si` (always lowercase, no `www`) |
| Chinese name | **XKnot 联邦** |
| English name | **XKnot Federation** |
| Chinese one-liner | XKnot 联邦 —— 面向 AI 与 Agent 时代的去中心化分布式信息网络 |
| English one-liner | XKnot Federation — a decentralized, distributed information network for the AI and Agent era. |

Leave one space between `XKnot` and Chinese, writing "XKnot 联邦", not "XKnot联邦". Use the em dash "——", not a single `-`.

**XKnot and Knot divide the work.** `XKnot` refers to this network and its brand; `Knot` refers only to the software used to deploy an instance (`knot-platform`) and the "based on Knot" attribution. An instance itself is still called a Knot instance, not an "XKnot instance".

## 1. What federation means

Federation means **members are sovereign**. Each instance has its own database, accounts, points, and review; the hub cannot decide anything on its behalf.

Instances do not talk to each other directly, nor authenticate each other. Each instance deals only with the hub, and the hub is read-only.

> Federation means member autonomy, not member interconnection.

The corresponding English name is XKnot Federation, not XKnot Alliance.

## 2. Three general rules

1. **One name, one meaning.** One Chinese name maps to exactly one concept, and one English name has exactly one meaning. Synonyms with different names ("hub / portal / center") are all forbidden.
2. **Chinese in Chinese, English in English.** Use the Chinese name in Chinese sentences and the English name in English sentences. Do not mix `hub` or `showcase` into Chinese.
3. **Proper nouns are not translated.** `XKnot`, `Knot`, `AgentLink`, `xknot.si`, `Agent`, `kMeta`, `post`, `fastpost`, `item` stay as-is. `Agent` is not rendered "智能体".

Typography rules:

- Leave one space between Chinese and Western characters or digits: "每 15 分钟" "6 张卡片" "基于 Knot".
- Chinese uses full-width punctuation, English uses half-width; quotes use 「」.

## 3. Federation-layer terms

The mnemonic: **profile, status, showcase.** One word per layer; saying "he only gave the profile, no status or showcase" is enough.

| Chinese | English | Identifier | Definition | Do not write |
|------|------|------|------|--------|
| XKnot 联邦 | XKnot Federation | — | the set of all instances, entered at `xknot.si` | Knot 生态平台、XKnot 联盟 |
| 中枢 | hub | `hub` | the read-only entry service at `xknot.si` | 中心、总站、主站、聚合平台 |
| 中枢主机 | hub host | — | the machine running the hub, hostname fixed as `xknot.si` | 云端、云主机、边缘机 |
| 实例 | instance | `instance` | an independently deployed Knot, with its own database and accounts | 节点、子站、分站、租户 |
| 实例主机 | instance host | — | the machine running the instance's Backend, database, and upload directory | 平台机、业务机 |
| 公网入口 | public entry | `entry` | the nginx for the instance domain: certificate, static WebUI, `/api` reverse proxy | 边缘、边缘入口、代理层 |
| 入口主机 | entry host | — | the machine running the public entry | 边缘主机、边缘机、CDN 节点 |
| 回源隧道 | reverse tunnel | `tunnel` | the SSH reverse tunnel the instance initiates, connecting the entry's loopback port to the instance | 端口映射、穿透隧道 |
| 伙伴 | partner | `partner` | an entity that operates an instance | 商户、加盟商、客户 |
| 运营方 | operator | `operator` | the operating entity that signs outward | 站长、厂商 |
| 主理人 | owner | `owner` | the person responsible for a specific instance | 管理员、负责人 |
| 站点档案 | site profile | L1 | the hub-written issued zone plus the owner-written self-described zone | 资料、简介页、商家信息 |
| 实例清单 | instance manifest | `instances.json` | the single instance registry file | 注册表、数据库 |
| 运行状态 | runtime status | L2 | the health and version the hub probes | 监控、埋点 |
| 健康探测 | health probe | `check-health` | the scheduled GET of an instance's `/api/health` | 心跳、巡检（巡检另有其义） |
| 健康点 | health dot | — | the dot representing status on the page | 指示灯、信号 |
| 热点橱窗 | showcase | L3 | the fixed 6 cards the partner publishes and the hub fetches on a schedule | 信息流、推荐流、广场、热榜 |
| 橱窗卡片 | showcase card | `card` | an entry in the showcase; must have a link back to the origin site | 帖子、情报、文章 |
| 橱窗拉取 | showcase fetch | `fetch-cards` | the scheduled GET of the partner's `cardsUrl` | 同步、灌入、上报 |
| 活动数据拉取 | stats fetch | `fetch-stats` | the scheduled GET of the partner's `statsUrl` | 埋点、统计上报 |
| 委托发信 | mail relay | `relay` | the instance hands a notification to the hub's SMTP for delivery | 代发、转发邮件、邮件网关 |
| 发信凭据 | relay token | `relayToken` | the token the hub issues to an instance, revocable on its own | API Key、密钥 |
| 发信额度 | relay quota | `dailyLimit` | a credential's 24-hour sending cap | 限额、配额 |
| 发信记录 | relay log | `relay_log` | records only the recipient domain and result, no body | 邮件日志、发信历史 |
| 收录 | listing | `listed` | writing an instance into the manifest | 入驻、签约（上架 belongs to the store） |
| 下架 | delist | `delisted` | removing it from the manifest; the hub stops showing it | 封禁、关闭、撤下 |
| 接入形态 | access mode | `mode` | only `subdomain`: hub-issued subdomain + entry tunnel (`own-domain` is retired) | 类型、方案 |
| 待验收 | pending | `status: pending` | already in the manifest, `/api/health` not yet passing | 未上线 |
| 示范入口 | demo entry | `tier: demo` | an official sample entry | 样板站 |
| 旗舰 | flagship | — | the self-operated primary instance | 主站、总站 |
| 门户 | portal | `portal` | that one page inside the hub | 首页、官网 |
| 语种 | locale | `locale` | the identifier of the page language, e.g. `zh-CN` | 语言包、语系 |
| 区域 | region | `region` | the country or region where the instance sits (where the machine is) | 大区、片区、服务对象所在地 |

### Store and showcase are not the same

Two displays in two different places. They must not share a word.

| Chinese | English | Identifier | Where | Do not write |
|------|------|------|------|--------|
| 店面 | store | `store` | an instance, at `/store` | 市场、广场、商城 |
| 商品 | item | `item` | on the shelf, with a price | 帖子、产品（a `post` is never an item） |
| 订单 | order | `order` | one completed sale | 流水（the ledger is separate） |
| 在售 | on sale | `on_sale` | a store record shown on the shelf | 收录（that is the hub） |
| 撤下 | withdrawn | `withdrawn` | the owner took it off the shelf | 下架（hub only） |

The test: the showcase is six cards the hub displays from what a partner published; the store is what an owner sells inside one instance. A post is content, not goods.

### Two pairs of easily confused words

- **Delist** (hub) vs **remove** (instance). When an admin removes a piece of content inside an instance, that is "remove"; when the hub removes a whole instance from the manifest, that is "delist".
- **Runtime status** (L2, probed by the hub) vs **health status** (returned by the instance's own `/api/health`). The thing on the page is the "health dot"; what the endpoint returns is the "health status".

### Machines and roles

**A role is a responsibility; a machine is hardware.** One machine can be both hub host and entry host at once — the current deployment is exactly that — but configuration ownership still follows the role: the hub's belongs to `xknot.si/ops/`, and the instance's own belongs to `knot-platform/sites/<site>/`.

**The entry belongs to the hub, and is split by scope; do not merge them:**

- Entry software — **the generator**: `xknot.si/server/provision.mjs` and `ops/provision-worker.mjs` render every subdomain's placeholder, static root, nginx conf, certificate, tunnel account and sshd block.
- `xknot.si/ops/entry/` — **records for one issued subdomain**: a conf that deviates from the generator, its connection runbook. It is an issuance record, not software, and only hub staff change it.

The instance side runs the tunnel and the Backend; it never writes anything on the entry host.

**The word "edge" is retired.** It looks like a CDN edge node yet is often physically on the same machine as the hub, so readers cannot tell whether it means the hub or the entry. Write "entry host" for the entry and "hub host" for the hub. The full concept map and ownership are in [docs/concepts.md](../../docs/concepts.md).

## 4. Status values

Always English lowercase in JSON; the UI shows local text.

**Two axes, two names. They are never merged and never share a value.**

*Decision* — `status`: the hub's ruling on whether this instance is in service. It is what makes the entry probe, list, and proxy. Written only in `instances.json`.

| JSON | Chinese | Meaning |
|------|------|------|
| `pending` | 待验收 | recorded, not yet verified: not probed, not on the portal |
| `active` | 运营中 | verified and in service |
| `suspended` | 暂停 | entry kept, not probed, not on the portal |
| `retired` | 已退役 | awaiting removal from the manifest |

*Observation* — `health`: what the hub last saw when it knocked. Never written into `status`, never a decision.

| JSON | Chinese | Meaning |
|------|------|------|
| `up` | 正常 | probe succeeded, returned within 2 seconds |
| `degraded` | 迟缓 | probe succeeded but took over 2 seconds |
| `down` | 中断 | probe failed |
| `unknown` | 未知 | no observation yet |

A console badge that reads "待验收" or "未探测" is a **projection** of the two axes for display. It is not a third vocabulary and is not part of any contract.

## 4a. Tier values

`demo`, `free`, `paid` are tier values, also lowercase and not translated. A tier is a **display rank**: it orders the portal, and nothing else. It does not gate a feature, a quota, or a price, and it is not derived from `role`.

| JSON | Chinese | Meaning |
|------|------|------|
| `demo` | 示例 | an official sample entry, not a partner site |
| `free` | 免费 | free tier |
| `paid` | 收费 | paid tier |

`founder` and `partner` are **roles** (`federation.json`), never tiers. A role is who someone is in the federation; a tier is how their entry is ranked. The two files do not constrain each other.

## 5. Code identifiers

When a concept name changes, the code identifier does not move. This is the contract.

| Location | Rule | Example |
|------|------|----|
| JSON fields | camelCase | `statsUrl`, `cardsUrl`, `formatVersion` |
| File names | kebab-case | `check-health.mjs`, `build-hub-data.mjs` |
| Instance `id` | lowercase kebab, 2–32 chars | `wang`, `travel`, `ai` |
| Status values | lowercase | `up`, `active` |
| Env vars | UPPER_SNAKE with `KNOT_` or `XKNOT_` prefix | `XKNOT_HUB_DIR` |
| Directories | lowercase, no spaces | `xknot.si/`, `docs/`, `ops/` |
| Domains | all lowercase | `xknot.si`, `wang.xknot.si` |

English concept-name casing: lowercase in prose (`the hub`, `an instance`); title case in headings, table headers, and diagram labels (`Hub`, `Instance`). Use one style per document.

## 6. Forbidden words and replacements

| Do not write | Why | Write instead |
|------|------|--------|
| 节点 | implies a peer-to-peer network | 实例 |
| 边缘、云端边缘、边缘主机、边缘机 | looks like a CDN edge node yet often sits with the hub; readers cannot tell which | 入口主机 (the nginx machine); "中枢主机" when referring to the hub itself |
| 租户 | implies multi-tenant sharing of one deployment | 实例 |
| 子站、分站 | implies a subordinate copy | 实例 |
| 中心、总站 | contrary to "member autonomy" | 中枢 |
| 平台 | the hub is an entry | 中枢; "实例" when referring to Knot itself |
| 信息流、推荐流 | L3 is a showcase | 橱窗 |
| 聚合平台 | the hub does not aggregate content | 中枢 |
| 入驻 | implies review | 收录 |
| 市场、广场、商城、出售区 | a marketplace with many sellers; a Knot instance is one shop with one owner | 店面 store; 商品 item |
| 同步、上报 | implies the partner writes to the hub | 拉取 |

## 7. Locale and region

Locale tags are code and are not translated. Region grouping names are display text and are translated.

| Item | Rule | Example |
|----|------|----|
| Locale tag | BCP 47, as-is in code | `en`, `zh-CN`, `zh-TW` |
| Locale self-name | native spelling, not translated | `English`, `简体中文`, `繁體中文` |
| Default locale | `en` | the hub defaults to English |
| Country code | ISO 3166-1 alpha-2, uppercase | `SG`, `SI`, `JP` |
| Region grouping | lowercase kebab, as a text key | `east-asia`, `southeast-asia` |
| Timezone | IANA | `Asia/Singapore`, not `GMT+8` |

Region grouping bilingual table:

| Key | Chinese | English |
|----|------|---------|
| `global` | 全球 | Global |
| `east-asia` | 东亚 | East Asia |
| `southeast-asia` | 东南亚 | Southeast Asia |
| `south-asia` | 南亚 | South Asia |
| `central-asia` | 中亚 | Central Asia |
| `middle-east` | 中东 | Middle East |
| `europe` | 欧洲 | Europe |
| `north-america` | 北美 | North America |
| `latin-america` | 拉美 | Latin America |
| `africa` | 非洲 | Africa |
| `oceania` | 大洋洲 | Oceania |
| `other` | 其他 | Other |

Three easy mistakes:

- **"Region" is not "territory".** `region` refers to the country or region where the instance sits — where the machine is — not the target audience, and not "大区" or "片区". The region the portal shows is based on the egress IP.
- **"Chinese" splits into simplified and traditional.** Never write just `zh`; the page shows `简体中文` / `繁體中文`.
- **`Agent` is not translated.** In an English sentence, `agent` may be lowercase; the term "Agent era" keeps the capital A.

## 8. Standard sentences

Use these when introducing the federation or talking to partners, to avoid everyone writing their own.

**One-liner**

> XKnot 联邦是一个以 `xknot.si` 为入口的信息网络。成员各自部署、各自运营，中枢只做入口。

> XKnot Federation is an information network entered at xknot.si. Members deploy and operate their own instances; the hub is an entry point only.

**Boundary**

> 中枢只读：站点档案、运行状态、热点橱窗都由中枢主动取，没有数据写入口。委托发信是唯一例外——只送信，不留内容。

> The hub is read-only: site profiles, runtime status and showcases are fetched by the hub. Delegated mail is the only exception: it sends a message, it keeps no content.

**Ownership**

> 实例的内容、账号和积分属于伙伴。中枢不托管，也不参与运营和收费。

**Attribution**

> Based on Knot

A partner may write "based on Knot" on their own site. Official certification, `XKnot 联邦官方`, `Powered by XKnot`, and `xknot.si` subdomains are issued by the rights holder.

## 9. Examples

Correct:

> 伙伴把橱窗发布在自己的站点，中枢在构建时取一次。
> 这个实例的健康点是中断，上次正常在 3 小时前。
> 本季度新增两个实例，一个给了档案和状态，另一个还只有档案。

Wrong and why:

| Wording | Problem |
|------|------|
| 伙伴把内容推送到中枢的聚合平台 | the hub neither accepts pushes nor aggregates |
| 中枢数据库里只有一张实例表 | the hub has no database |
| 这个节点挂了 | use "实例"; "挂" should be "中断" |
| 我们入驻了 XKnot 联邦 | use "收录"; listing is registration, not approval |
| 打开信息流看六条热榜 | L3 is a showcase, fixed 6 cards, no ranking |
| 智能体时代的信息网络 | `Agent` is not translated |
