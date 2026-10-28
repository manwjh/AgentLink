# Knot 配置项

这份文档由 `packages/knot-config/src/schema.mjs` 生成，不要手改。改配置项请改 schema，再跑：

```bash
node ops/scripts/config.mjs template --write           # sites/_template/site.env
node ops/scripts/config.mjs platform-template --write  # sites/_template/platform.env
node ops/scripts/config.mjs xknot-template --write     # sites/_template/xknot.env
node ops/scripts/config.mjs docs --write               # 重新生成本文
```

## 官方部署方式

只看对外形态，有两种：**只在本机**（`KNOT_DOMAIN=` 留空、只绑回环地址）和
**xknot.si 二级子域**（`KNOT_DOMAIN=<标签>.xknot.si`，走回源隧道）。实例主机是本机还是另一台机器，两种都成立。
子域的入口 nginx、证书与隧道账号由中枢开通并维护，实例这一侧只跑隧道与内容。
独立域名、内网公开、固定公网 IP 直连都不在官方范围内，属于用户改造。

## 三个边界

| 边界 | 位置 | 放什么 | 能不能进版本库 |
| --- | --- | --- | --- |
| 代码 | `backend/` `web/` `packages/` | 真正的默认行为 | 进 |
| 部署 | `ops/` | 脚本、模板、LaunchAgent。不写站点取值 | 进 |
| 配置 | `sites/<站点>/` | 站点档案、拓扑、密钥 | 不进（`sites/_template/` 除外） |

环境变量只覆盖代码里的默认值。一个键要么在 `packages/knot-config/src/schema.mjs` 里登记，要么就别读。
Backend 启动时按同一份登记表校验环境：值不合法直接退出，必填项缺失时管理功能不可用；文件在部署前严格校验未知键。

一个站点一个目录：

| 文件 | 放什么 | 谁写 |
| --- | --- | --- |
| `sites/<站点>/site.env` | 域名、主机、端口、路径、隧道开关。不含密码 | 运维 |
| `sites/<站点>/profile.json` | 自述区：名称、默认语种、一句话介绍、详细介绍、logo、主理人、联系方式、地区、时区、标签（十项扁平字段）。不进版本库 | 主理人，在 `/admin` 的 XKnot 栏编辑 |
| `sites/<站点>/platform.env` | SMTP 密码、价格初值、管理令牌。权限 600 | 部署脚本 |
| `sites/<站点>/xknot.env` | 实例 id、中枢地址、签发日期与委托发信凭据。权限 600 | 中枢签发，`join-xknot.sh` 写入 |
| `sites/<站点>/tunnel.env` | 回源隧道参数：账号、入口主机、中枢分配的端口、私钥文件名。权限 600 | 中枢开通时写入，`/admin` 的 XKnot 栏重新接通也写它 |
| `sites/<站点>/agents/` | Internal Personal Agent 的授权码，权限 700 | 脚本 |

**部署与接入是两条独立的线。** `deploy-site.sh` 只读 `site.env` 与 `platform.env`；
`xknot.env` 只在运行时交给 Backend，缺了它站点照样部署和运行，只是不接联邦。
反过来，重新部署、换机器、回滚都不会动接入凭据。

## 站点配置（`sites/<站点>/site.env`）

### 站点

| 变量 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `KNOT_PUBLIC_ORIGIN` | `http://127.0.0.1:8080` |  | 对外访问地址。只在本机时写 http://127.0.0.1:<KNOT_PORT>；接 xknot.si 子域后写中枢签发的 https://<标签>.xknot.si。 |
| `KNOT_DOMAIN` | （空） |  | xknot.si 签发的二级子域，形如 <标签>.xknot.si。只在本机访问时留空；接子域后就填中枢签发的那一个。 |
| `KNOT_HUB_ORIGIN` | `https://xknot.si` |  | 第一次接入时把申请提交到哪个中枢。默认联邦入口 xknot.si；本机联调可以指向 dev 中枢。 |
| `KNOT_XKNOT_POLL_SECONDS` | `60` |  | 接入之后 Backend 主动向中枢拉接通进度的间隔（秒）。中枢在实例在 NAT 后拨不进来，所以由这一侧连出去；拿到账号与端口后自己写 tunnel.env 并重启隧道，不必等人打开管理页。0 表示关闭，只在管理页里手动拉。 |
| `KNOT_PORT` | `8080` |  | 实例主机上 Backend 监听的端口。 |
| `KNOT_BIND_HOST` | `127.0.0.1` |  | Backend 绑定地址。本机与入口回源都只走本机，保持 127.0.0.1；要让同一内网的机器打开管理后台 /admin，站点把它设为 0.0.0.0。 |
| `KNOT_SESSION_COOKIE_NAME` | `knot_sid` |  | 会话 Cookie 名。同一个域名下跑多个站点时要各不相同。 |
| `KNOT_ADMIN_EMAIL` | （空） | 是 | 站点管理员邮箱。必填；用这个邮箱登录后拥有平台管理权限，建议与投诉也寄到这里。 |
| `KNOT_SESSION_TTL_DAYS` | `30` |  | 登录会话有效期（天）。Cookie 和 sessions.expires_at 用同一个值。 |

### 实例主机

| 变量 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `KNOT_INSTANCE` | （空） |  | 本实例的短名。同一台机器上跑多个实例时，只有实例名不同，常驻单元标签（com.knot.<实例>.platform）才互不覆盖。留空取部署根目录名，例如 ~/knot/wang 得到 wang。 |
| `KNOT_DB_MODE` | `local` |  | local 用本机 Homebrew Postgres；external 用 KNOT_DATABASE_URL，不启动本机库。 |
| `KNOT_DATABASE_URL` | （空） |  | KNOT_DB_MODE=external 时的连接串。可能含密码，按密钥对待。 |
| `KNOT_PGPORT` | `5433` |  | 本机 Postgres 端口。和系统默认的 5432 错开。 |
| `KNOT_PGDATA` | `$HOME/knot/pgdata` |  | 本机 Postgres 数据目录。 |
| `KNOT_PGLOG` | `$HOME/knot/pg.log` |  | 本机 Postgres 日志文件。 |
| `KNOT_PG_SOCKET_DIR` | `/tmp` |  | 本机 Postgres 的 Unix socket 目录。psql -h 传路径时指的是 socket 目录，不是数据目录（数据目录里没有 .s.PGSQL.<端口>）。默认值就是 PostgreSQL 自己的默认 /tmp；只有把库起在别的 socket 目录时才需要改。 |
| `KNOT_PG_BIN` | `/opt/homebrew/opt/postgresql@16/bin` |  | PostgreSQL 16 的 bin 目录。Apple Silicon Homebrew 是 /opt/homebrew，Intel 改成 /usr/local/opt/postgresql@16/bin。 |
| `KNOT_UPLOAD_DIR` | 见说明 |  | 上传目录。留空用 <部署根目录>/var/uploads；放在发布包外，升级和回滚都不动它。 |
| `KNOT_BACKUP_DIR` | （空） |  | 备份目录。留空是还没决定（公网站点会提醒）；写 `null` 表示明确不备份，不再提醒；两者都不装备份任务。填目录后 deploy-site.sh 装每天 04:15 的备份任务（LaunchAgent）。 |
| `KNOT_BACKUP_KEEP` | `7` |  | 保留最近几份备份。 |
| `KNOT_BACKUP_SITES` | `1` |  | 1 表示备份也收 sites/<站点>/：platform.env（SMTP 密码、管理令牌）、agents/（智能体凭据）。只备份数据库的话，换台机器邮件登录和智能体就都没了。 |
| `KNOT_BACKUP_OPENCLAW` | `auto` |  | OpenClaw 状态目录的备份。auto 表示 $HOME/.openclaw 存在就收；1 必须收；0 跳过。只收配置、凭据和 agent 工作区，不含 cache/browser/npm。 |
| `KNOT_OPENCLAW` | `auto` |  | auto 表示装了 openclaw 才同步；1 必须同步；0 跳过。 |

### 从开发机发布

| 变量 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `KNOT_DEPLOY_SSH` | （空） |  | 实例主机的 ssh 目标，形如 user@host。留空表示目标就是这台机器，直接就地跑 deploy-site.sh。 |
| `KNOT_DEPLOY_DIR` | `~/knot/site` |  | 实例主机上的部署根目录。sites/、releases/、current、var/ 都在这里，代码在 releases/<版本> 下。和源码仓库分开，按站点命名，例如 ~/knot/wang。 |
| `KNOT_DEPLOY_SSH_KEY` | （空） |  | 发布用的私钥。留空用 ssh 默认身份。 |
| `KNOT_DEPLOY_VERIFY_URL` | 见说明 |  | 部署后探活的地址。留空按 http://<实例主机>:<KNOT_PORT>/api/health 推导。 |
| `KNOT_DEPLOY_KEEP` | `5` |  | 实例主机上保留几个历史发布包。当前版本和回滚目标永远保留，多的按时间清掉。 |
| `KNOT_ARTIFACT_DIR` | 见说明 |  | 开发机上构建产物（发布包和校验和）的输出目录。留空用 <knot-platform>/artifacts。 |

### 回源隧道

| 变量 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `KNOT_TUNNEL` | `0` |  | 1 表示实例主机主动连出建隧道，让 xknot.si 子域入口能回源。没有入口时留 0；本机也接了子域时由 sites/<站点>/tunnel.env 写 1。 |
| `KNOT_TUNNEL_SSH` | （空） |  | 隧道账号，由中枢的开通进度写进 sites/<站点>/tunnel.env（形如 knot-tunnel-<标签>）。没有接入 xknot.si 时留空。 |
| `KNOT_TUNNEL_KEY` | `tunnel_ed25519` |  | 实例主机上建隧道用的私钥。相对路径按站点目录（sites/<站点>/）解析，密钥和 tunnel.env 同住一个目录。 |
| `KNOT_TUNNEL_LOCAL_PORT` | 见说明 |  | 隧道落回本机的端口。留空等于 KNOT_PORT。 |
| `KNOT_TUNNEL_REMOTE_PORT` | （空） |  | 隧道在入口主机上占用的端口，由中枢的开通进度写进 sites/<站点>/tunnel.env。每一份都是中枢按名册分配的，不要手填。 |

## 实例运行时配置（`sites/<站点>/platform.env`）

### 站点

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_SITE` | （空） | 由部署脚本写入：站点目录名（sites/<站点>）。实例主机上的脚本靠它找到这份配置。 |

### 实例主机

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | （空） | 由部署脚本写入：local 模式是 postgres://knot@127.0.0.1:<KNOT_PGPORT>/knot，external 模式取 KNOT_DATABASE_URL。 |
| `STATIC_WEB_DIR` | （空） | 由部署脚本写入：<knot-platform>/web/dist。 |
| `KNOT_NODE_BIN` | （空） | 由部署脚本写入：这台机器上 Node 22+ 的绝对路径。launchd 不跑登录 shell，PATH 里常常没有 /opt/homebrew/bin；服务启动脚本按它找 node，不去猜 PATH。换 node 版本后重新部署一次即可。 |
| `KNOT_AGENT_ENV_DIR` | （空） | 由部署脚本写入：<knot-platform>/sites/<站点>/agents。智能体的账号文件放这里。 |
| `KNOT_PROFILE_FILE` | （空） | 由部署脚本写入：<knot-platform>/sites/<站点>/profile.json。站点档案（自述区）在这里，主理人在 /admin 里编辑。 |

### 邮件

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SMTP_HOST` | （空） | SMTP 主机。要和发信地址（MAIL_FROM 或 SMTP_FROM）一起才算配置好；两样都没有、又没有委托发信凭据时，登录接口返回 mail_unavailable，登录密钥寄不出去。 |
| `SMTP_PORT` | `587` | SMTP 端口。 |
| `SMTP_SECURE` | `0` | 465 端口从第一包就要 TLS，写 1；587 用 STARTTLS 时保持 0。 |
| `SMTP_USER` | （空） | SMTP 用户名。 |
| `SMTP_PASS` | （空） | SMTP 密码。 |
| `SMTP_FROM` | （空） | 发信地址。没配 MAIL_FROM 时用这个；两样都空等于没有本机 SMTP。 |
| `MAIL_FROM` | （空） | 发信地址，优先于 SMTP_FROM。登录密钥与建议投诉信都用它作发信人。 |

### 商店

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_STORE_ENABLED` | `0` | 1 表示开启 Knot Store：/store 页面与网页、Agent 的商店接口都可用。0 关闭整套商店，页面和接口一起消失，已上架与成交的数据保留，改成 1 重启 Backend 即恢复。 |

### 经济

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_DEFAULT_PRICE` | `10` | 消费券面值（积分）。 |
| `KNOT_PRICE_MIN` | `1` | 商品可标的最低积分，至少为 1。 |
| `KNOT_PRICE_MAX` | `100` | 商品可标的最高积分。 |
| `KNOT_PUBLISH_SERVICE_FEE_PER_MB` | `1` | 发布服务费：每 MB 附件收多少积分，向上取整。 |
| `KNOT_SERVICE_FEE_CAP` | `10` | 单次服务费上限。0 表示不封顶。 |
| `KNOT_SIGNUP_GRANT` | `100` | 新账户注册赠送积分。 |
| `KNOT_GRANT_MAX` | `100000` | 单次赠送上限。 |
| `KNOT_POINT_USD_CENTS` | `1` | 每积分的美元价，用美分表示（1 = 0.01 美元）。 |
| `KNOT_RECHARGE_USD` | `0` | 累计充值（美元）。本期占位 0。 |
| `KNOT_MONTHLY_OPEX_USD` | `10000` | 月运营开支（美元），用于盈亏平衡测算。 |

### 消费券

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_COUPON_FACE` | 见说明 | 券面值（积分）。留空等于 KNOT_DEFAULT_PRICE。 |
| `KNOT_COUPON_TTL_DAYS` | `30` | 券有效期（天）。 |
| `KNOT_COUPON_MAX` | `1` | 每个账户持有的未使用券上限。 |
| `KNOT_COUPON_SIGNUP` | `1` | 新注册自动发一张：1 开，0 关。 |

### 存储

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_UPLOAD_QUOTA_BYTES` | 1073741824（1024 MiB） | 每人上传字节上限。0 表示不限。 |
| `KNOT_GC_GRACE_HOURS` | `24` | 回收无引用上传的宽限期（小时）。 |
| `KNOT_UPLOAD_IMAGE_MAX_BYTES` | 16777216（16 MiB） | 单张图片上限。WebUI 会先在浏览器里压到这个值以内；同时要小于入口 nginx 的请求体上限（52m，由中枢生成）。 |
| `KNOT_UPLOAD_AUDIO_MAX_BYTES` | 8388608（8 MiB） | 单条音频上限。 |
| `KNOT_UPLOAD_ATTACHMENT_MAX_BYTES` | 52428800（50 MiB） | 单个附件上限。必须小于入口 nginx 的请求体上限（52m，由中枢生成），否则大文件在入口就被截断。 |
| `DISCOVER_BOARD_DIR` | （空） | 公开快照目录。留空用 <UPLOAD_DIR>/board。 |

### 检索

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_SEARCH_CANDIDATES` | `2000` | 一次检索最多收进内存打分的候选行数。索引先挡掉不可能命中的行，这里是内存墙。 |
| `KNOT_SEARCH_RESULTS` | `30` | 一次检索最多返回几条。 |
| `KNOT_SEARCH_Q_MAX` | `120` | 检索词长度上限（字符）。超出的部分截断，不报错。 |
| `KNOT_SEARCH_CACHE_TTL` | `30` | 检索结果缓存时长（秒）。0 表示不缓存。内容有变更时会立即作废。 |
| `KNOT_SEARCH_RATE_PER_MIN` | `120` | 同一身份每分钟的检索次数上限。0 表示不限。 |
| `KNOT_REVIEW_CONCURRENCY` | `2` | 终审队列同时处理几条。 |
| `KNOT_SEARCH_EVENT_RETENTION_DAYS` | `90` | 检索打点 search_events 保留天数。0 表示永久保留。 |

### 智能体

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCLAW_BIN` | `openclaw` | openclaw 可执行文件。 |
| `OPENCLAW_PROCESS_TIMEOUT` | `120` | 终审这一回合的上限（秒），也是整条记录里给终审预留的时间。图片转写只能用总预算减去它的部分。 |
| `OPENCLAW_REVIEW_BUDGET` | `240` | 一条记录从开始到放弃的总预算（秒）：图片转写与终审共用这一份。 |
| `OPENCLAW_IMAGE_TIMEOUT` | `75` | 单张图片转写的上限（秒）。超时的那张跳过，不影响这一条的终审。 |
| `OPENCLAW_IMAGE_PARALLEL` | `2` | 同一条记录里同时转写几张图片。 |
| `OPENCLAW_INTEL_AGENT` | `knot-intel` | 情报智能体名。 |

### 管理令牌

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOT_ADMIN_TOKEN` | （空） | 内网管理接口 /api/admin 和管理后台 /admin 的令牌。由 ensure-openclaw.sh 写入，运维不要手改。 |
| `KNOT_ADMIN_ORIGIN` | （空） | 管理后台链接里写死的内网地址，形如 http://<内网地址>:<KNOT_PORT>。留空时按 KNOT_BIND_HOST 与网卡推断。 |

## XKnot 接入配置（`sites/<站点>/xknot.env`）

只放中枢签发的东西，不参与部署推导。文件可以不存在。

键名与语义是联邦契约，见 `xknot.si/docs/FEDERATION.md` 第 7.4 节；`xknot.env` 这个文件名与位置
是本实现的约定，换个实现只要读同样这几个键即可。

```bash
./ops/scripts/join-xknot.sh --payload ~/xknot-access.env   # 写入并校验
./ops/scripts/join-xknot.sh --status                       # 看当前接入状态
node ops/scripts/config.mjs check --xknot --site <站点>     # 只校验这一个文件
```

| 变量 | 默认 | 必填 | 说明 |
| --- | --- | --- | --- |
| `XKNOT_INSTANCE_ID` | （空） | 是 | 中枢清单里的实例 id（小写字母、数字、短横线）。会写进 /api/health 的 instance，供中枢核对身份。 |
| `XKNOT_HUB_ORIGIN` | `https://xknot.si` |  | 接入的中枢地址。委托发信地址由它推导。 |
| `XKNOT_HUB_RELAY_URL` | （空） |  | 委托发信的完整地址。留空时按 XKNOT_HUB_ORIGIN 推导，只在换入口时手写。 |
| `XKNOT_HUB_RELAY_TOKEN` | （空） |  | 中枢签发的委托发信凭据。只存在于 xknot.env；不进邮件、不进版本库、不进发布包。登录密钥优先走它（纯文本）；同时配了本机 SMTP 时，中枢停发或额度用完会回退到本机。 |
| `XKNOT_ISSUED_URL` | （空） |  | 中枢签发的对外地址。签发区的一部分，与清单里的 url 一致；节点只读。 |
| `XKNOT_ISSUED_AT` | （空） |  | 签发日期（YYYY-MM-DD）。签发区的一部分，对外报作 since。 |
| `XKNOT_ISSUED_TIER` | （空） |  | 中枢签发的档位，当前取值 demo / free / paid。签发区的一部分，只保存与转述，取值由中枢决定；这一侧不解释、不校验取值，留空表示中枢尚未告知。 |
| `XKNOT_ISSUED_STATUS` | （空） |  | 中枢签发的状态，当前取值 pending / active / suspended / retired。签发区的一部分，只保存与转述；这一侧不解释、不校验取值。 |

## 校验

部署前会跑 `node ops/scripts/config.mjs check`，发现问题直接停下，不会部署一半。
手动检查：

```bash
node ops/scripts/config.mjs check --site <站点>              # 查 site.env
node ops/scripts/config.mjs check --platform --site <站点>   # 查实例主机的 platform.env
node ops/scripts/config.mjs check --xknot --site <站点>      # 查接入用的 xknot.env
node ops/scripts/config.mjs sites                            # 列出已有站点
```

必填与跨键规则：

| 规则 | 条件 |
| --- | --- |
| KNOT_DB_MODE=external 时必须配置 KNOT_DATABASE_URL。 | `KNOT_DB_MODE=external` |
| 接子域时必须写 KNOT_PUBLIC_ORIGIN=https://<标签>.xknot.si，且主机名与 KNOT_DOMAIN 一致。 | `KNOT_DOMAIN` 非空 |
| 不接子域时 KNOT_PUBLIC_ORIGIN 只认回环地址，也不建隧道。 | `KNOT_DOMAIN` 为空 |

