# xknot.si 中枢部署

面向算力助理 / 运维：在公网主机上托管**联盟门户**的静态站与申请接口。

这是联盟门户自己的部署。用 `knot-platform` 部署的伙伴站点不在这里，也不由这套脚本管理；两台若是同一台机器，只说明共用主机，不构成依赖。

这台机器同时是**中枢主机**和**入口主机**（`wang.xknot.si` 等实例入口）。角色与归属见 [`docs/concepts.md`](../../docs/concepts.md)：中枢的配置归本项目的 `ops/`，每个已签发子域的入口 conf 由开通进程渲染并安装，两边不互相引用。

## 主机

仓库里不写死主机。下面的值只是当前实例，改动时以实际那台为准，或直接覆盖环境变量。

```bash
HUB=ec2-user@54.169.33.64
KEY=~/.ssh/suanli-sg-probe.pem
```

| 项 | 值 |
|----|----|
| 区域 | `ap-southeast-1` |
| 实例 | `i-0c876685a64c75538` |
| 公网 | `54.169.33.64`（随 EIP / 重建变化） |
| SSH | `ssh -i $KEY $HUB`（`id_rsa` 在这台机上会被拒） |
| DNS | `xknot.si` 与 `www` 的 A 记录指向这里 |
| 同机其它站点 | 这台机同时托管实例侧站点：`/var/www/wang`（`wang.xknot.si`），以及无关的 `/var/www/aiugc`。`conf.d/` 下各配置各自独立，改 conf 前务必 `nginx -t` |

门户与这些实例站点共用一台机器，但目录、进程与配置互不重叠：门户是 `/var/www/xknot` + `/opt/xknot` + `xknot-api`，实例是各自的 `ops/` 部署产物。共用的只是 nginx 进程、证书目录与这台机的容量。

## 路径

| 路径 | 用途 |
|------|------|
| `/var/www/xknot` | 门户静态（`web/dist`） |
| `/opt/xknot/server` | 接口源码 `server/index.mjs` |
| `/opt/xknot/admin` | 控制台静态 |
| `/opt/xknot/docs` | 本项目文档（systemd 的 `Documentation=`） |
| `/opt/xknot/instances.json` | 接口读取的实例清单（委托发信判断实例是否在册、是否 active） |
| `/opt/xknot/ops/validate-instances.mjs` | 清单校验（`manifest.mjs` 依赖） |
| `/opt/xknot/ops/{check-health,watch-health,fetch-guard}.mjs` | 定时健康巡检：探测、发信、暂时隐藏 |
| `/opt/xknot/ops/{peers,geoip}.mjs` | 站点位置：隧道对端 → 出口 IP → 国家码 |
| `/opt/xknot/var/geoip/` | DB-IP Lite 库 + IP 判定缓存 + `locations.json`（生成物，约 4.5 MB，不入仓） |
| `/opt/xknot/web/src/lib/{i18n,regions}.js` | 校验依赖 |
| `/opt/xknot/var` | SQLite / session-secret（`0600`，勿入仓） |
| `/etc/nginx/conf.d/xknot.si.conf` | 门户 + `/api` `/admin` 反代 |
| `/etc/systemd/system/xknot-api.service` | 接口常驻 |
| `/etc/systemd/system/xknot-health.{service,timer}` | 每 15 分钟巡检一次 |
| `/etc/systemd/system/xknot-provision.service` | 自动接通：逐项配置入口主机，探测通过后改 `active` |
| `/opt/xknot/var/provision.env` | 自动接通的输入：`XKNOT_ENTRY_HOST`（`0600`，首次部署由 `XKNOT_ENTRY_HOST` 生成） |

## 环境变量（systemd）

见 unit `ops/xknot-api.service`：

| 变量 | 生产值 |
|------|--------|
| `XKNOT_API_HOST` | `127.0.0.1` |
| `XKNOT_API_PORT` | `5181` |
| `XKNOT_DATA_DIR` | `/opt/xknot/var` |
| `XKNOT_TRUST_PROXY` | `1` |
| `XKNOT_SECURE_COOKIE` | 有 HTTPS 时 `1`（当前 unit 已置 `1`）；只在 HTTP 阶段临时关掉 |
| `XKNOT_PUBLIC_ORIGIN` | `https://xknot.si` |
| `EnvironmentFile` | `-/opt/xknot/var/mail.env`，可选；不存在时只是不发信 |

接口只监听回环；nginx 反代 `/api/`、`/admin/`。

自动接通另有一份输入，见 unit `ops/xknot-provision.service`：

| 变量 | 生产值 |
|------|--------|
| `XKNOT_ENTRY_HOST` | 入口主机公网地址（与中枢同机时为 `54.169.33.64`）；写 `/opt/xknot/var/provision.env`，不写进 unit |
| `XKNOT_ADMIN_EMAIL` | 证书登记邮箱，复用 `mail.env` 里的 `XKNOT_ADMIN_EMAIL` |
| `XKNOT_PROVISION_INTERVAL_MS` | 可选，默认 `20000` |
| `XKNOT_AWAITING_TIMEOUT_MS` | 可选，默认 `1800000`（30 分钟）：入口侧做完后等隧道多久算停滞，超过只记一条事件，不重试前置 |
| `XKNOT_SNAPSHOT_INTERVAL_MS` | 可选，默认 `20000`（最短 `5000`）：多久经隧道取一次各实例的公开快照，内容没变不写盘 |
| `XKNOT_AFTER_ACTIVATE` | 可选；改成 `active` 后执行的命令，例如重建门户 |
| `XKNOT_WEB_ROOT` | 门户静态根，当前 unit 已置 `/var/www/xknot`：接通后重算的 `data/hub.json` 写这里，与 `xknot-republish.service` 同一份取值 |

worker 每轮只推进一步，失败只记错误码（`dns_missing`、`tls_failed`…）并按退避重试（30 秒 / 2 分 / 10 分 / 30 分 / 2 小时，按步独立计数），这些码会原样出现在实例管理界面的 XKnot 栏。`tls` 连续失败 5 次就停下转 `failed`，不再自动重试：继续试只会把 Let's Encrypt 的失败授权限制（每主机名每小时 5 次）越拉越长。前置做完后停在 `awaiting_tunnel` 等对端来拉参数，超过 30 分钟记一条 `instance.awaiting_stalled`。它需要 `sudo`：建账号、写 sshd 与 nginx 配置、跑 certbot。**DNS 不在它手里**——入口域名需要一条泛解析 `*.xknot.si → XKNOT_ENTRY_HOST`；没有它，`dns` 这一步永远过不去。

## 邮件（可选）

发信凭据不进 unit（unit 是 `0644`），单独放 `/opt/xknot/var/mail.env`，权限 `0600`：

```bash
ssh -i "$KEY" "$HUB"
sudo install -m 600 -o ec2-user -g ec2-user /dev/null /opt/xknot/var/mail.env
sudo -u ec2-user vi /opt/xknot/var/mail.env
```

内容（阿里云邮件推送，465 隐式 TLS）。`SMTP_HOST` 跟着控制台区域走：华东是 `smtpdm.aliyun.com`，新加坡是 `smtpdm-ap-southeast-1.aliyuncs.com`。

```bash
SMTP_HOST=smtpdm.aliyun.com
SMTP_PORT=465
SMTP_SECURE=1
SMTP_USER=no-reply@xknot.si
SMTP_PASS='该发信地址的 SMTP 密码，不是阿里云登录密码'
SMTP_FROM=no-reply@xknot.si
MAIL_FROM=no-reply@xknot.si
XKNOT_ADMIN_EMAIL=manwjh@gmail.com
```

`xknot.si` 的 MX 已经指向 `mx01.dm.aliyun.com`，这个域只发信；不要再给它配企业邮箱收信。

`SMTP_USER` 必须与 `SMTP_FROM` 一致，这是阿里云邮件推送的认证规则。改完 unit 或 env 后：

```bash
sudo systemctl daemon-reload
sudo systemctl restart xknot-api
sudo -u ec2-user bash -c 'set -a; . /opt/xknot/var/mail.env; set +a; cd /opt/xknot && npm run mail:test -- manwjh@gmail.com'
```

测试信只证明 SMTP 认证与投递通了；是否进箱要看收件方原始邮件头里的 `spf=pass`、`dkim=pass`、`dmarc=pass`。发信域名在阿里云控制台验证后，DNS 记录不要删。

新建发信地址或刚改 SMTP 密码后，阿里云侧生效有延迟，约 10 分钟内仍会返回 `535 Authentication failure`；先等一会儿再试，不要急着当成密码错误。区域要与控制台一致，华东是 `smtpdm.aliyun.com`，拿华东的地址去打新加坡端点同样报 535。

共享给伙伴时，一个发信域名下按站点建不同发信地址，每个地址单独设 SMTP 密码；伙伴只填上面 6 个 `SMTP_*` / `MAIL_FROM`，不要拿到中枢的管理员邮箱与会话密钥。

## 构建与部署

```bash
cd xknot.si

# 静态站
./ops/build-hub.sh                 # 或 --offline
XKNOT_HUB_SSH=$HUB XKNOT_SSH_KEY=$KEY ./ops/deploy-hub.sh

# 接口、控制台与配置
XKNOT_HUB_SSH=$HUB XKNOT_SSH_KEY=$KEY ./ops/deploy-api.sh
```

`deploy-hub.sh` 已 `--exclude .well-known`，避免冲掉 ACME 挑战目录；它带 `--delete`，所以先拒绝空值、根目录、站点父目录与源目录本身，真同步前再空跑一次把要删的路径打出来。`deploy-api.sh` 同步 `server/`、`admin/`、`docs/`、`instances.json`、巡检与采集脚本（含 `ops/geoip.mjs`、`ops/peers.mjs`、`ops/node-status.mjs`、`ops/traffic.mjs`）与清单校验依赖，安装 nginx 配置与六个 systemd unit（`xknot-api`、`xknot-provision`、`xknot-health.{service,timer}`、`xknot-traffic.{service,timer}`）。nginx 配置先备份（`<conf>.bak-<UTC 时间>`，留最近 10 份）再落盘，`nginx -t` 不通过就恢复旧文件并退出；通过后才 daemon-reload、重启接口、启用两个 timer、reload nginx，最后在回环上验证 `/api/health`。两者互不覆盖。

先看会做什么，不连远端：

```bash
XKNOT_HUB_SSH=$HUB ./ops/deploy-hub.sh --dry-run
XKNOT_HUB_SSH=$HUB ./ops/deploy-api.sh --dry-run
```

## nginx 现状

- `xknot.si` / `www.xknot.si`：443 提供门户，`/` 302 到 `/en/`；80 只留 ACME 并 301 到 HTTPS。
- 443 的 server 里开了 gzip（文本类，含 JS/CSS/JSON/SVG/XML）；不压图片与字体，它们本来就压过。门户是纯静态站，这一层不压就没有别处可压。
- `/api/`、`/admin/` 反代到 `127.0.0.1:5181`；`/assets/` 长缓存，`/data/hub.json` 用 `no-cache`。
- 门户带 HSTS、`nosniff`、`Referrer-Policy`、`X-Frame-Options: DENY` 与 CSP；`/admin/` 的严格 CSP 由接口的 `serveAdminFile` 发出，nginx 只补 HSTS。`/assets/` 与 `/data/hub.json` 不要写 `add_header`，否则 nginx 会丢掉 server 级安全头。
- 没有其它子域。`root.xknot.si` 已删除：DNS 记录、nginx 配置与证书都清理掉了，不要重新加回来。
- 证书由 Certbot 管理，不动 `ssl_certificate` 那几行。

## 证书

```bash
# 1) 确认 A/AAAA 已指向本机，HTTP ACME 可通
curl -sI -H 'Host: xknot.si' http://54.169.33.64/.well-known/acme-challenge/ping

# 2) 签证书（webroot）
sudo certbot certonly --webroot -w /var/www/xknot -d xknot.si -d www.xknot.si

# 3) reload 并确认 Secure Cookie 已开
sudo nginx -t && sudo systemctl reload nginx
sudo systemctl show xknot-api -p Environment   # 应含 XKNOT_SECURE_COOKIE=1
```

`xknot.si` 的证书覆盖 `xknot.si` 与 `www.xknot.si` 两个名字。

## 验收

按域名验（证书与 SNI 都走真实路径）：

```bash
curl -sI https://xknot.si/                        # 302 → /en/
curl -sI https://xknot.si/en/                     # 200
curl -sI -H 'Accept-Encoding: gzip' https://xknot.si/assets/<main js> | grep -i content-encoding  # gzip
curl -sI https://xknot.si/data/hub.json           # 200，no-cache
curl -s  https://xknot.si/api/health              # {"ok":true,...}
curl -sI https://xknot.si/admin/                  # 200
curl -sI https://xknot.si/api/admin/applications   # 401

# 同机其它站点不得受影响
curl -sI https://wang.xknot.si/                   # 实例，200
```

在 DNS 还没切、只想验这台机时，用 `--resolve` 指定解析，不要直接连 IP：

```bash
curl -sI --resolve xknot.si:443:54.169.33.64 https://xknot.si/
```

## instances.json 备注

清单里当前有三个实例：创始实例 `wang`（`https://wang.xknot.si`）、创始人的国际站点 `cpswang`（`https://cpswang.xknot.si`，旗舰实现示范）与 `zhoujj`（`https://zhoujj.xknot.si`），都是 `subdomain` 模式、`status: active`，前两者 `tier: paid`。清单里没有探测地址字段，地址恒为 `url` + `/api/health`。`root.xknot.si` 已下线，不要再登记。门户可以先上线；探测结果是构建时采样，不影响静态站与申请接口。

## 新增与下架实例

新增一条：自动接通会自己写清单与名册（`status` 先 `pending`，验收后改 `active`），不需要手工登记；**要人工做的是把它同步回仓库**——`./ops/deploy-api.sh --pull-manifest`（只拉清单与名册，先解析再落盘；仓库里这两份有未提交改动时拒绝执行），然后 `npm run validate` 并提交。手工加一条时：先改 `federation.json`（身份、隧道账号与端口），再改 `instances.json`（签发区），然后 `npm run validate`。下架一条：两个文件同时删掉这条，再删入口主机上的 conf 与静态根；`var/health.json` 与 `var/status.json` 下次巡检会自然丢掉它，`var/profiles/` 里的副本要手工删。子域跟着 `*.xknot.si` 的泛解析走，没有单独的 DNS 记录要清。

## 实例侧

实例怎么部署、隧道怎么配，不在本文范围。当前实例实现是 `knot-platform`：隧道见 `knot-platform/ops/README.md` 第 4 节，主机与密钥由各自的 `sites/<站点>/site.env` 给出。换别的实现，本文不需要改——中枢只认 `/api/health` 与接入件。

## 禁止

- 未切 NS 前不要对 xknot.si 跑 certbot
- 不要改 Dynadot / 不要动 Route53 `zenheart` 区
- 不要 terminate 实例；不要停同机其它站点的服务
