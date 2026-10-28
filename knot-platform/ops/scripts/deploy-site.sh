#!/usr/bin/env bash
# 在一台 macOS 实例主机上安装一份**已经构建好的** Knot 发布包。
#
# 这里不做构建：不跑 npm ci，不跑 vite build。构建在开发机做（ops/scripts/build.sh），
# 产物是一个 tar.gz，解包后就是一个可运行的代码目录。
#
# 动手之前先过主机门禁（平台、基础工具、Node 22+、数据库）：缺什么就停下并给一行
# 能照做的命令，不等到停完服务、切完 current 才失败。门禁只检查、不装包；加
# --bootstrap 才让它调 ops/scripts/bootstrap-host.sh 装 Node 22+ 与 postgresql@16
# （只装 brew 包：不建库、不改端口、不装系统服务），装完复检一次。
#
# 目录布局（部署根 = KNOT_DEPLOY_DIR）：
#   sites/<站点>/       配置，升级不动
#   releases/<版本>/    代码，一个发布包一份
#   current -> releases/<版本>
#   var/uploads/        数据，回滚不动
#   var/log/
#   deployed.json       当前版本、上一个版本
#
# 用法：
#   ./ops/scripts/deploy-site.sh --site wang                    # 在发布包目录里
#   ./ops/scripts/deploy-site.sh --site wang --artifact <tar.gz>
#   ./ops/scripts/deploy-site.sh --site wang --dry-run          # 只检查，不动手
#   ./ops/scripts/deploy-site.sh --site local --artifact <tar.gz> --deploy-root "$PWD"
#                                                                # local：目标就是本机
#   ./ops/scripts/deploy-site.sh --site wang --runtime none     # 不装成开机自启，后台起
#   ./ops/scripts/deploy-site.sh --site wang --bootstrap        # 门禁不过时先补 Node/Postgres
#
# 从开发机一步完成构建、传输和部署用 ./ops/scripts/push-deploy.sh。
# 实例主机只支持 macOS + launchd（main 分支）；别的平台要 fork 发布层。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SITE_ARG=""
ARTIFACT_ARG=""
DEPLOY_ROOT_ARG=""
RUNTIME_ARG=""
DRY_RUN=0
NO_ROLLBACK=0
ALLOW_PLATFORM_MISMATCH=0
BOOTSTRAP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--site 后面要跟站点名" >&2; exit 2; }
      SITE_ARG="$2"
      shift 2
      ;;
    --artifact)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--artifact 后面要跟 tar.gz 或发布包目录" >&2; exit 2; }
      ARTIFACT_ARG="$2"
      shift 2
      ;;
    --deploy-root)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--deploy-root 后面要跟目录" >&2; exit 2; }
      DEPLOY_ROOT_ARG="$2"
      shift 2
      ;;
    --runtime)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--runtime 后面要跟 launchd / none" >&2; exit 2; }
      RUNTIME_ARG="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --bootstrap)
      BOOTSTRAP=1
      shift
      ;;
    --no-auto-rollback)
      NO_ROLLBACK=1
      shift
      ;;
    --allow-platform-mismatch)
      ALLOW_PLATFORM_MISMATCH=1
      shift
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done
[[ -n "$SITE_ARG" ]] && export KNOT_SITE="$SITE_ARG"
# 从解包出来的临时目录安装时，部署根还没法从脚本位置推出来，先显式给它。
[[ -n "$DEPLOY_ROOT_ARG" ]] && export KNOT_DEPLOY_ROOT="$DEPLOY_ROOT_ARG"

# shellcheck source=lib/site-config.sh
source "$SCRIPT_DIR/lib/site-config.sh"
# shellcheck source=lib/artifact-guard.sh
source "$SCRIPT_DIR/lib/artifact-guard.sh"

# xknot.si 自动接通把隧道这一组写在 tunnel.env，site.env 里的 KNOT_TUNNEL 仍是 0。
# 部署脚本也要读它，否则私钥预检和部署后的公网探活都会被跳过——接了子域的站点
# 恰恰最需要这两项，而「本机好、入口 502」正是从这里漏出去的。
if [[ -f "${KNOT_SITE_DIR:-}/tunnel.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$KNOT_SITE_DIR/tunnel.env"
  set +a
fi
# 「这个站点接了入口」只看两份配置：有 tunnel.env，或 site.env 里显式写了
# KNOT_TUNNEL=1 并给了账号。见 lib/site-config.sh 的 knot_tunnel_unit_action。
CONFIG_ARGS=(--site "$KNOT_SITE")

# ---- 0. 主机门禁 ----
# 先看平台、基础工具和 node：下面校验发布包本身就要用 node，缺了连报错都不可靠。
# 这一步只读，不装任何东西；所以 --dry-run 也照跑。
# shellcheck source=lib/host-check.sh
source "$SCRIPT_DIR/lib/host-check.sh"
KNOT_PF_BOOTSTRAP_HINT=1

knot_host_checks() {
  knot_check_host_platform
  knot_check_tools
  knot_check_node
}

# 门禁 + 可选的补装：--bootstrap 才动系统包，而且只动 Node 与 postgresql@16。
# 装完必须复检：brew 退出码 0 不等于这个版本能用（见 bootstrap-host.sh）。
knot_gate() {
  local title="$1"
  shift
  knot_pf_begin
  "$@"
  knot_pf_finish "$title" && return 0
  if [[ "$BOOTSTRAP" != 1 ]]; then
    return 1
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    echo
    echo "dry-run：加 --bootstrap 会先装 Node 22+ / postgresql@16，再复检一次。"
    return 1
  fi
  echo
  echo "==> bootstrap host（只装 brew 包：不建库、不改端口、不装系统服务）"
  "$SCRIPT_DIR/bootstrap-host.sh" --site "$KNOT_SITE" --deploy-root "$KNOT_DEPLOY_ROOT" --yes || return 1
  knot_pf_begin
  "$@"
  knot_pf_finish "$title"
}

echo "==> check host"
knot_gate "主机" knot_host_checks || exit 1

# ---- 0. 发布包 ----
# 允许 --artifact 指 tar.gz：解到暂存区，再把代码目录切过去。
STAGING=""
TMP_REL=""
PREV_TARGET=""
# 停过服务、又没走到「新版本已探活通过」就退出时，退出码不会自己把站点拉起来。
# 这两个标记让 cleanup 判断要不要兜底回滚（见下面的 trap）。
SERVICE_STOPPED=0
DEPLOY_LIVE=0
RESCUE_DONE=0
cleanup() {
  local code=$?
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  # 同名重装时解包目录要等停服务后才换名；中途失败就别把它留在 releases/ 里。
  if [[ -n "$TMP_REL" && -d "$TMP_REL" ]]; then
    rm -rf "$TMP_REL"
  fi
  # 只删自己拿的那把锁：接管过别人的之后，别把继任者的锁一起删掉。
  if [[ -n "${LOCK_DIR:-}" && -f "$LOCK_DIR/pid" ]]; then
    if [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")" == "$$" ]]; then
      rm -rf "$LOCK_DIR"
    fi
  fi
  # 服务已经停了、新版本又没通过探活就退出（迁移、写 platform.env、装 unit 都可能
  # 失败，set -e 会直接跳到这里）：把 current 切回上一个版本再拉起来。
  # 否则站点一直停着，而部署输出里只有一行报错，没人知道还要手动重启。
  if (( SERVICE_STOPPED == 1 && DEPLOY_LIVE == 0 && RESCUE_DONE == 0 )); then
    RESCUE_DONE=1
    echo "部署没有跑完（退出码 ${code}），把 Backend 拉回上一个版本。" >&2
    if [[ -n "$PREV_TARGET" ]]; then
      ln -sfn "$PREV_TARGET" "$KNOT_DEPLOY_ROOT/current"
      echo "    current → ${PREV_TARGET}" >&2
    fi
    restart_backend || echo "警告：自动拉起失败，请手动重启（./ops/scripts/run-knot-platform.sh）。" >&2
  fi
  return 0
}
trap cleanup EXIT

if [[ -n "$ARTIFACT_ARG" ]]; then
  [[ -e "$ARTIFACT_ARG" ]] || knot_fail "找不到发布包：$ARTIFACT_ARG"
  if [[ -d "$ARTIFACT_ARG" ]]; then
    KNOT_APP_DIR="$(cd "$ARTIFACT_ARG" && pwd -P)"
    export KNOT_APP_DIR
  else
    "$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" verify "$ARTIFACT_ARG" >/dev/null ||
      knot_fail "发布包校验失败：$ARTIFACT_ARG"
    # 校验和只证明「包没被改过」，不证明「包里的路径没往外走」。解包写的是系统目录，
    # 所以先看成员名单：绝对路径、`..` 段、指向包外的链接一律拒绝（S16-01）。
    knot_check_tar_members "$ARTIFACT_ARG" ||
      knot_fail "发布包里有会写到部署目录之外的成员：$ARTIFACT_ARG"
    STAGING="$(mktemp -d "${TMPDIR:-/tmp}/knot-release.XXXXXX")"
    # --no-same-owner：包里的 uid/gid 不该带到这台机器上。
    tar -xzf "$ARTIFACT_ARG" -C "$STAGING" --no-same-owner
    APP_IN_TAR="$(find "$STAGING" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
    [[ -n "$APP_IN_TAR" ]] || knot_fail "发布包里没有目录：$ARTIFACT_ARG"
    KNOT_APP_DIR="$(cd "$APP_IN_TAR" && pwd -P)"
    export KNOT_APP_DIR
  fi
fi

[[ -f "$KNOT_APP_DIR/BUILD.json" ]] || knot_fail "这是源码目录，不是发布包。
先在开发机构建：  ./ops/scripts/build.sh
或者一步到位：    ./ops/scripts/push-deploy.sh --site $KNOT_SITE
从 tar.gz 安装：  ./ops/scripts/deploy-site.sh --site $KNOT_SITE --artifact <tar.gz>"

# ---- 0.5 OpenClaw 环境预检（只提醒，不阻断） ----
"$KNOT_NODE_BIN" "$KNOT_APP_DIR/ops/scripts/check-openclaw-env.mjs" || true

MANIFEST="$KNOT_APP_DIR/BUILD.json"
REL_NAME="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" field release "$MANIFEST")"

# REL_NAME 来自 BUILD.json，会直接拼进路径，还参与 rm -rf。发布包是外部输入
# （可以从别处拷来的 tar.gz），所以按不可信字符串处理：只允许字母、数字和 . _ + -，
# 并且不能以 . 开头、不能含 ..。否则一个 release 写成 ../../.. 就能删到发布根外面。
case "$REL_NAME" in
  "" | .* | *..* | *[!A-Za-z0-9._+-]*)
    knot_fail "BUILD.json 里的 release 名字不合法：'${REL_NAME}'
这个名字会拼进 releases/ 下的目录、参与删除与回滚。只允许字母、数字和 . _ + -，
且不能以 . 开头或包含 ..。请修 BUILD.json 或重新构建。"
    ;;
esac
[[ "${#REL_NAME}" -le 120 ]] || knot_fail "release 名字太长（${#REL_NAME} 字符，上限 120）：${REL_NAME}"

REL_VERSION="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" field version "$MANIFEST")"
REL_COMMIT="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" field commit "$MANIFEST")"
REL_PLATFORM="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" field platform "$MANIFEST")"
HOST_PLATFORM="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" platform)"
if [[ "$REL_PLATFORM" != "$HOST_PLATFORM" && "$ALLOW_PLATFORM_MISMATCH" != 1 ]]; then
  knot_fail "发布包是 ${REL_PLATFORM}，这台机器是 ${HOST_PLATFORM}。
   原生模块（如 sharp）不能跨平台。请在这台机器同平台的环境里重新构建。
确知没问题时加 --allow-platform-mismatch。"
fi

# 发布包必须自带生产依赖。目标机不跑 npm ci（ops/README.md 的交付前提），
# 而 --no-modules 打出来的包名与默认包完全一样，只在 BUILD.json 的 modules
# 字段上有差别；这个字段不读的话，解包后 node_modules 是空的，一路走到探活
# 才失败，报错看起来像「后端起不来」。
REL_MODULES="$("$KNOT_NODE_BIN" "$SCRIPT_DIR/artifact.mjs" field modules "$MANIFEST")"
if [[ "$REL_MODULES" != "true" ]]; then
  knot_fail "这个发布包不带 node_modules（BUILD.json 里 modules=${REL_MODULES:-false}）。
目标机不跑 npm ci，装上去起不来。用不带 --no-modules 的 ./ops/scripts/build.sh 重新打包。"
fi

# ---- 1. 站点配置 ----
echo "==> check sites/$KNOT_SITE/site.env"
"$KNOT_NODE_BIN" "$SCRIPT_DIR/config.mjs" check "${CONFIG_ARGS[@]}"

# main 只支持 macOS + launchd。--runtime none 留着给“装了但不想常驻”和临时机器，
# 它不是第二种平台；非 Darwin 在主机门禁那一步就已经停下了。
RUNTIME="${RUNTIME_ARG:-launchd}"
case "$RUNTIME" in
  launchd | none) ;;
  *) knot_fail "--runtime 只能是 launchd 或 none（实例主机只支持 macOS + launchd）。" ;;
esac

# ---- 1.5 数据库就绪（门禁）----
# 只读：本机库看 bin 齐不齐，外部库真连一次、把失败翻译成一句话。
# 建库与起库仍在第 3 步；这里拦的是「等停完服务、切完 current 才发现库连不上」。
echo "==> check database"
knot_gate "数据库" knot_check_database || exit 1

# 站点端口被别的程序占着时，失败会拖到「换完 current、跑完迁移、起 Backend」才发生，
# 然后自动回滚；在这个只读阶段先说就便宜得多。这里不走 knot_gate：端口冲突不是缺包，
# 让 --bootstrap 再装一遍没有意义。
knot_pf_begin
if ! knot_check_site_port; then
  knot_pf_finish "端口" 0
  exit 1
fi

# 本实例可能有的常驻单元。停服务时整组都保留，只收掉引用本部署根的旧标签单元。
INSTANCE_ROLES="platform postgres backup gc entry-tunnel openclaw-probe"

# 启停就这一个入口：迁移失败回滚和正常启动都走它。
restart_backend() {
  case "$RUNTIME" in
    launchd)
      knot_install_launchd "$KNOT_APP_DIR/ops/launchd/platform.plist" "$(knot_label platform)"
      ;;
    *)
      # 没有服务管理器时自己拉起后台进程：KNOT_SITE 决定读哪份 platform.env，
      # pid 记在 var/run/backend.pid，回滚时也走这里先把上一个进程停掉。
      MANUAL_LOG_DIR="$KNOT_DEPLOY_ROOT/var/log"
      MANUAL_RUN_DIR="$KNOT_DEPLOY_ROOT/var/run"
      mkdir -p "$MANUAL_LOG_DIR" "$MANUAL_RUN_DIR"
      MANUAL_PID_FILE="$MANUAL_RUN_DIR/backend.pid"
      if [[ -f "$MANUAL_PID_FILE" ]]; then
        OLD_PID="$(cat "$MANUAL_PID_FILE" 2>/dev/null || true)"
        if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
          echo "==> stop backend (pid $OLD_PID)"
          kill "$OLD_PID" 2>/dev/null || true
          for _ in $(seq 1 50); do
            kill -0 "$OLD_PID" 2>/dev/null || break
            sleep 0.1
          done
        fi
        rm -f "$MANUAL_PID_FILE"
      fi
      echo "==> start backend in background (pid → var/run/backend.pid)"
      # 用干净环境启动，和 launchd 一样只认 platform.env，不要继承部署脚本导出的 site 键。
      # 新开会话：部署脚本退出后它要还在。
      knot_start_detached "$MANUAL_PID_FILE" "$MANUAL_LOG_DIR/knot-platform.log" \
        env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
        KNOT_SITE="$KNOT_SITE" KNOT_DEPLOY_ROOT="$KNOT_DEPLOY_ROOT" \
        "$KNOT_APP_DIR/ops/scripts/run-knot-platform.sh"
      # 等它把 pid 写进来，不要立刻探活。
      for _ in $(seq 1 50); do
        [[ -s "$MANUAL_PID_FILE" ]] && break
        sleep 0.1
      done
      ;;
  esac
}

# 对外地址还写 127.0.0.1 时提醒一次：别人通过这个地址拿分享图和二维码会打不开。
# 但只绑回环地址的站点（开发者的本机实例）本来就只在自己这台机器上看，不算问题。
case "$(knot_origin_host "$KNOT_PUBLIC_ORIGIN")" in
  127.0.0.1 | localhost | "")
    case "${KNOT_BIND_HOST:-127.0.0.1}" in
      127.0.0.1 | localhost | ::1 | "")
        ;;
      *)
        knot_warn "KNOT_PUBLIC_ORIGIN 还是本机地址；分享图和二维码会指向 ${KNOT_PUBLIC_ORIGIN}。要让别人访问，请走 xknot.si 子域部署。"
        ;;
    esac
    ;;
esac

# 反过来的情形：站点在域名上、别的设备也能打开，管理后台却只绑了回环。
# 那时「我的」页复制出去的链接在别的设备上打不开，而部署本身是成功的。
ADMIN_LINK_HINT="$(knot_admin_link_hint)"
if [[ -n "$ADMIN_LINK_HINT" ]]; then
  knot_warn "$ADMIN_LINK_HINT"
fi

# 隧道是实例唯一通向出口的一段：密钥或账号缺了，部署成功也只会换来入口 502，
# 所以在这里就停下，而不是等有人点开页面才发现。
if knot_enabled KNOT_TUNNEL; then
  knot_require KNOT_TUNNEL_SSH "KNOT_TUNNEL=1 时要有隧道账号，由 sites/<站点>/tunnel.env 写入。"

  TUNNEL_KEY="$(knot_tunnel_key_path)"
  if [[ ! -f "$TUNNEL_KEY" ]]; then
    knot_fail "隧道私钥不存在：${TUNNEL_KEY}
  来自 KNOT_TUNNEL_KEY=${KNOT_TUNNEL_KEY:-（空，按站点目录取 tunnel_ed25519）}
  隧道起不来时入口会一直 502。先把公钥装到入口主机的 $KNOT_TUNNEL_USER 账号；
  密钥确实丢了，就在 /admin 的 XKnot 栏重新接通（会生成新密钥并让中枢重跑）。"
  fi
fi

REL_DIR="$KNOT_RELEASES_DIR/$REL_NAME"
UPGRADE=0
PREV_TARGET=""
if [[ -e "$KNOT_DEPLOY_ROOT/current" ]]; then
  PREV_TARGET="$(readlink "$KNOT_DEPLOY_ROOT/current" 2>/dev/null || true)"
  [[ "$PREV_TARGET" == "releases/$REL_NAME" ]] || UPGRADE=1
fi

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "dry-run：检查通过，没有改动任何文件。"
  echo "  发布包    $REL_NAME  ($REL_VERSION $REL_COMMIT, $REL_PLATFORM)"
  echo "  部署根    $KNOT_DEPLOY_ROOT"
  echo "  装到      $REL_DIR"
  echo "  当前版本  ${PREV_TARGET:-(未安装)}"
  echo "  运行时    $RUNTIME"
  if [[ "$KNOT_DB_MODE" == "external" ]]; then
    echo "  数据库    external（$([[ -n "$KNOT_DATABASE_URL" ]] && echo "KNOT_DATABASE_URL 已配置" || echo "缺 KNOT_DATABASE_URL")）"
  else
    echo "  数据库    local 127.0.0.1:${KNOT_PGPORT}（socket ${KNOT_PG_SOCKET_DIR}，数据目录 ${KNOT_PGDATA}）"
  fi
  echo "  数据目录  $KNOT_UPLOAD_DIR"
  echo "  配置      $KNOT_PLATFORM_ENV"
  echo "  接入      $([[ -f "$KNOT_XKNOT_ENV" ]] && echo "$KNOT_XKNOT_ENV" || echo "未接入 XKnot（可选）")"
  exit 0
fi

# ---- 并发保护 ----
# 两个部署同时跑会互相覆盖 current 链接、互相删 releases/ 下的目录，
# 表现是「部署成功但版本不对」，而且两次都说 OK。用目录当锁：mkdir 是原子的。
LOCK_DIR="$KNOT_DEPLOY_ROOT/.deploy.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  HOLDER="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")"
  if [[ -n "$HOLDER" ]] && kill -0 "$HOLDER" 2>/dev/null; then
    knot_fail "另一个部署正在跑（pid ${HOLDER}），本次不动手。
等它结束再重试；确认它卡死了，先看 ${LOCK_DIR}，再手动删掉。"
  fi
  # 持锁进程已经不在了：上次部署被强杀，没来得及清理。接管它。
  knot_warn "接管残留的部署锁（pid ${HOLDER:-未知} 已不存在）。"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || knot_fail "抢不到部署锁：$LOCK_DIR"
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"

# ---- 2. 装发布包 ----
mkdir -p "$KNOT_RELEASES_DIR"
APP_PHYSICAL="$(cd "$KNOT_APP_DIR" && pwd -P)"
REPLACE_PENDING=0
if [[ "$APP_PHYSICAL" != "$(cd "$KNOT_RELEASES_DIR" && pwd -P)/$REL_NAME" ]]; then
  echo "==> install $REL_DIR"
  TMP_REL="$KNOT_RELEASES_DIR/.$REL_NAME.$$"
  rm -rf "$TMP_REL"
  mkdir -p "$TMP_REL"
  rsync -a --delete "$KNOT_APP_DIR/" "$TMP_REL/"
  chmod +x "$TMP_REL/ops/scripts/"*.sh 2>/dev/null || true
  if [[ -e "$REL_DIR" ]]; then
    # 同名重装：脚本名由代码内容算出，所以覆盖安装是常态，而 REL_DIR 此刻
    # 很可能正是正在跑的那一份代码。先别删——服务还开着，后面还有几步要用它。
    # 记下来，停服务之后再换（第 4 步），这样删的不会是在跑的目录。
    REPLACE_PENDING=1
    KNOT_APP_DIR="$(cd "$TMP_REL" && pwd -P)"
  else
    mv "$TMP_REL" "$REL_DIR"
    TMP_REL=""
    KNOT_APP_DIR="$(cd "$REL_DIR" && pwd -P)"
  fi
else
  echo "==> already installed $REL_DIR"
  KNOT_APP_DIR="$(cd "$REL_DIR" && pwd -P)"
fi
export KNOT_APP_DIR

VENV_SCRIPTS="$KNOT_APP_DIR/ops/scripts"
mkdir -p "$KNOT_DEPLOY_ROOT/var/log" "$KNOT_DEPLOY_ROOT/var/uploads" "$KNOT_SITE_DIR/agents"
chmod 700 "$KNOT_SITE_DIR" "$KNOT_SITE_DIR/agents"
chmod +x "$VENV_SCRIPTS/"*.sh 2>/dev/null || true

APP_ENV="$KNOT_PLATFORM_ENV"

# 旧机器把备份目录写在环境文件里；部署配置没写时沿用，避免升级后备份悄悄停掉。
if [[ -z "$KNOT_BACKUP_DIR" ]]; then
  KNOT_BACKUP_DIR="$(knot_env_get "$APP_ENV" KNOT_BACKUP_DIR)"
fi
# null / none / off 是「明确不备份」：归一成空，后面按「未配置」处理，不装任务。
# 不归一的话 backup-knot.sh 会去建一个叫 null 的目录。
BACKUP_OFF_EXPLICIT=0
case "$(printf '%s' "$KNOT_BACKUP_DIR" | tr '[:upper:]' '[:lower:]')" in
  null | none | off) BACKUP_OFF_EXPLICIT=1 ;;
esac
KNOT_BACKUP_DIR="$(knot_backup_dir "$KNOT_BACKUP_DIR")"
KNOT_UPLOAD_DIR="$(knot_expand_path "$KNOT_UPLOAD_DIR")"

# ---- 3. 数据库 ----
if [[ "$KNOT_DB_MODE" == "external" ]]; then
  [[ -n "$KNOT_DATABASE_URL" ]] || knot_fail "KNOT_DB_MODE=external 时必须配置 KNOT_DATABASE_URL。"
  DATABASE_URL="$KNOT_DATABASE_URL"
elif [[ -n "$KNOT_DATABASE_URL" ]]; then
  DATABASE_URL="$KNOT_DATABASE_URL"
else
  # 每次都跑：这个脚本是幂等的（已初始化、已启动都跳过对应步骤）。
  # 只在「端口没响应」时才跑，会漏掉上一次半途失败留下的状态——库起来了、
  # knot 角色却还没口令，下一次部署走到 createdb 才报「认证失败」。
  echo "==> ensure local postgres ($KNOT_PGDATA)"
  KNOT_PGPORT="$KNOT_PGPORT" KNOT_PGDATA="$KNOT_PGDATA" KNOT_PGLOG="$KNOT_PGLOG" \
    KNOT_PG_BIN="$KNOT_PG_BIN" KNOT_PG_SOCKET_DIR="$KNOT_PG_SOCKET_DIR" \
    "$VENV_SCRIPTS/ensure-knot-postgres.sh"
  # 端口上已经有库时也要确保 knot 这个库存在；已存在就忽略。
  # 新建的库是 scram 认证，口令在站点目录的 pg-knot-password（0600）；
  # 已存在的库可能是 trust，没有这个文件，照旧不带口令。
  PG_PW_FILE="$KNOT_SITE_DIR/pg-knot-password"
  PG_PW=""
  if [[ -f "$PG_PW_FILE" ]]; then PG_PW="$(cat "$PG_PW_FILE" 2>/dev/null || true)"; fi
  if ! CREATEDB_OUT="$(PGPASSWORD="$PG_PW" "$KNOT_PG_BIN/createdb" -h 127.0.0.1 -p "$KNOT_PGPORT" -U knot knot 2>&1)"; then
    case "$CREATEDB_OUT" in
      *"already exists"*) ;;
      *)
        knot_fail "createdb 失败：${CREATEDB_OUT}"
        ;;
    esac
  fi
  DATABASE_URL="postgres://knot${PG_PW:+:$PG_PW}@127.0.0.1:$KNOT_PGPORT/knot"
fi
export DATABASE_URL

# ---- 4. 停服务 → 换目录（同名重装）→ 迁移 ----
case "$RUNTIME" in
  launchd)
    # 先收掉引用本部署根的旧标签单元：它们 KeepAlive，会在新单元起来时抢同一个端口。
    # 本实例这一组（下面这六种角色）留着，迁移和后面的安装还要用它们。
    INSTANCE_KEEP=""
    for _role in $INSTANCE_ROLES; do
      INSTANCE_KEEP="${INSTANCE_KEEP} $(knot_label "$_role")"
    done
    knot_prune_launchd $INSTANCE_KEEP
    knot_bootout_launchd "$(knot_label platform)"
    ;;
  *) ;;
esac
SERVICE_STOPPED=1

# 同名重装到这一步才换目录：上面用的还是旧的那一份（配置预检、私钥检查都读它），
# 现在服务停了，删掉再换名不会动到正在运行的代码。换完 current 会短暂悬空，
# 紧接着第 5 步会重指；这期间站点本来就是停的。
if (( REPLACE_PENDING == 1 )); then
  if [[ "$RUNTIME" == "none" ]]; then
    # 没有服务管理器时进程还跑在旧目录上（脚本是从 current/ 拉起的）。
    # 先停掉它再删目录，否则它随后的 require 会命中「文件已删除」。
    MANUAL_PID_FILE="$KNOT_DEPLOY_ROOT/var/run/backend.pid"
    if [[ -f "$MANUAL_PID_FILE" ]]; then
      OLD_PID="$(cat "$MANUAL_PID_FILE" 2>/dev/null || true)"
      if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "==> stop backend (pid ${OLD_PID})"
        kill "$OLD_PID" 2>/dev/null || true
        for _ in $(seq 1 50); do
          kill -0 "$OLD_PID" 2>/dev/null || break
          sleep 0.1
        done
      fi
      rm -f "$MANUAL_PID_FILE"
    fi
  fi
  echo "==> replace $REL_DIR"
  rm -rf "$REL_DIR"
  mv "$TMP_REL" "$REL_DIR"
  TMP_REL=""
  KNOT_APP_DIR="$(cd "$REL_DIR" && pwd -P)"
  export KNOT_APP_DIR
  VENV_SCRIPTS="$KNOT_APP_DIR/ops/scripts"
  chmod +x "$VENV_SCRIPTS/"*.sh 2>/dev/null || true
fi

echo "==> migrate"
migrated=0
MIGRATE_LOG="$(mktemp "${TMPDIR:-/tmp}/knot-migrate.XXXXXX")"
for _ in $(seq 1 5); do
  if DATABASE_URL="$DATABASE_URL" "$KNOT_NODE_BIN" "$KNOT_APP_DIR/backend/scripts/migrate.js" >"$MIGRATE_LOG" 2>&1; then
    migrated=1
    break
  fi
  sleep 2
done
cat "$MIGRATE_LOG"
rm -f "$MIGRATE_LOG"
if [[ "$migrated" != 1 ]]; then
  # 迁移失败时把旧版本拉回来，别让站点空着。这里已经自己处理过收尾，
  # 别再让 cleanup 重复重启一次。
  RESCUE_DONE=1
  if [[ -n "$PREV_TARGET" ]]; then
    knot_warn "迁移失败。当前版本仍是 ${PREV_TARGET}。"
    ln -sfn "$PREV_TARGET" "$KNOT_DEPLOY_ROOT/current"
    restart_backend
  fi
  knot_fail "迁移失败。检查 DATABASE_URL 和数据库是否已启动。"
fi

# ---- 5. 切换版本 ----
if [[ "$UPGRADE" == 1 ]]; then
  echo "==> current: ${PREV_TARGET:-无} → releases/$REL_NAME"
else
  echo "==> current: releases/$REL_NAME"
fi
ln -sfn "releases/$REL_NAME" "$KNOT_DEPLOY_ROOT/current"

# ---- 6. 运行时环境文件 ----
# 值从哪里来、哪些键会被写，全在 packages/knot-config/src/schema.mjs 里定义。
# 已有的注释和运维改过的邮件、价格键都会保留，只更新部署相关的值。
echo "==> write $APP_ENV"
# KNOT_NODE_BIN 一起交给 config.mjs：服务的启动脚本按它找 node，不去猜 PATH
# （launchd 不跑登录 shell，PATH 里常常没有 /opt/homebrew/bin）。
export KNOT_BACKUP_DIR KNOT_UPLOAD_DIR DATABASE_URL KNOT_NODE_BIN
"$KNOT_NODE_BIN" "$KNOT_APP_DIR/ops/scripts/config.mjs" env "${CONFIG_ARGS[@]}" \
  --out "$APP_ENV" --root "$KNOT_DEPLOY_ROOT/current" --deploy-root "$KNOT_DEPLOY_ROOT"
"$KNOT_NODE_BIN" "$KNOT_APP_DIR/ops/scripts/config.mjs" check --platform --site "$KNOT_SITE"
# 接入文件可选；存在就一并校验，缺失只提示不报错。
"$KNOT_NODE_BIN" "$KNOT_APP_DIR/ops/scripts/config.mjs" check --xknot --site "$KNOT_SITE"
if [[ -f "$KNOT_XKNOT_ENV" ]]; then
  chmod 600 "$KNOT_XKNOT_ENV"
fi

# ---- 7. 服务 ----
case "$RUNTIME" in
  launchd)
    echo "==> install LaunchAgents"
    if [[ "$KNOT_DB_MODE" == "local" ]]; then
      knot_install_launchd "$KNOT_APP_DIR/ops/launchd/postgres.plist" "$(knot_label postgres)"
    else
      knot_bootout_launchd "$(knot_label postgres)"
    fi
    chmod +x "$VENV_SCRIPTS/backup-knot.sh" "$VENV_SCRIPTS/audit-knot-storage.sh" "$VENV_SCRIPTS/gc-knot-storage.sh"
    if [[ -n "$KNOT_BACKUP_DIR" ]]; then
      knot_install_launchd "$KNOT_APP_DIR/ops/launchd/backup.plist" "$(knot_label backup)"
    elif [[ "$BACKUP_OFF_EXPLICIT" == 1 ]]; then
      echo "==> KNOT_BACKUP_DIR=null：已明确关闭备份，不装备份 LaunchAgent"
      knot_bootout_launchd "$(knot_label backup)"
    else
      echo "==> KNOT_BACKUP_DIR 未配置，不装备份 LaunchAgent"
      knot_bootout_launchd "$(knot_label backup)"
    fi
    # 每月 1 日 04:45 只出回收报告，不删。要真删得人工加 --apply。
    knot_install_launchd "$KNOT_APP_DIR/ops/launchd/gc.plist" "$(knot_label gc)"
    # 旁路探测：每五分钟记一次 OpenClaw 宿主状态。没装 OpenClaw 时它只是把
    # unknown 写进 var/run，页面上那一块照实说「未知」，绝不显示成错误。
    knot_install_launchd "$KNOT_APP_DIR/ops/launchd/openclaw-probe.plist" "$(knot_label openclaw-probe)"
    # 隧道单元：账号与端口由中枢的开通进度写进 tunnel.env，有这份文件就装。
    # 两份配置都没提到隧道时保持现状：卸掉它等于让已接入口的站点当场 502，
    # 而这次发布并没有带来任何「隧道该撤掉」的依据。
    case "$(knot_tunnel_unit_action)" in
      install)
        echo "==> install entry tunnel LaunchAgent"
        knot_install_launchd "$KNOT_APP_DIR/ops/launchd/entry-tunnel.plist" "$(knot_label entry-tunnel)"
        ;;
      remove)
        echo "==> KNOT_TUNNEL 已明确关闭，卸下 entry tunnel LaunchAgent"
        knot_bootout_launchd "$(knot_label entry-tunnel)"
        ;;
      *)
        echo "==> 没有隧道配置，保留现有 entry tunnel 单元"
        ;;
    esac
    ;;
  *) ;;
esac

echo "==> start backend"
restart_backend

# ---- 8. 探活（失败自动回滚代码，数据库不回滚） ----
healthy=0
PUBLIC_UNREACHABLE=0
BODY=""
for _ in $(seq 1 30); do
  BODY="$(curl -sf --noproxy '*' "http://127.0.0.1:$KNOT_PORT/api/health" 2>/dev/null || true)"
  if [[ -n "$BODY" ]]; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "$healthy" == 1 ]]; then
  RUNNING_VERSION="$("$KNOT_NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).version || "")) } catch {}' "$BODY")"
  RUNNING_RELEASE="$("$KNOT_NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).release || "")) } catch {}' "$BODY")"
  RUNNING_COMMIT="$("$KNOT_NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).commit || "")) } catch {}' "$BODY")"
  # 发布包名以 BUILD.json 为准；老版本没有 release 字段时退回比版本号。
  # 端口上答话的不是本次装的这一份，就说明旧进程还占着端口、新进程没起来；
  # 这种情况必须判失败，否则「部署成功」而线上跑的是旧代码。
  MISMATCH=""
  if [[ -n "$RUNNING_RELEASE" && "$RUNNING_RELEASE" != "$REL_NAME" ]]; then
    MISMATCH="探活报的发布包是 ${RUNNING_RELEASE}，本次装的是 ${REL_NAME}。"
  elif [[ -z "$RUNNING_RELEASE" && -n "$RUNNING_VERSION" && "$RUNNING_VERSION" != "$REL_VERSION" ]]; then
    MISMATCH="探活报的版本是 ${RUNNING_VERSION}，发布包是 ${REL_VERSION}。"
  fi
  if [[ -n "$MISMATCH" ]]; then
    knot_warn "${MISMATCH} 端口上答话的是别的版本，很可能还有一个旧进程占着端口。"
    RESCUE_DONE=1
    if [[ -n "$PREV_TARGET" && "$NO_ROLLBACK" != 1 ]]; then
      ln -sfn "$PREV_TARGET" "$KNOT_DEPLOY_ROOT/current"
      restart_backend || true
      knot_fail "本次部署没有生效（${MISMATCH}）。current 已切回 ${PREV_TARGET}，先找出占着 $KNOT_PORT 的旧进程。"
    fi
    knot_fail "本次部署没有生效（${MISMATCH}）。先找出占着 $KNOT_PORT 的旧进程，再重跑部署。"
  fi
  if [[ -n "$RUNNING_COMMIT" && "$RUNNING_COMMIT" != "$REL_COMMIT" ]]; then
    knot_warn "探活报的提交是 ${RUNNING_COMMIT}，发布包是 ${REL_COMMIT}。"
  fi

  # 本机健康不等于站点能用：接了子域的站点，公网那一跳还要穿过隧道。
  # 隧道没起来时本机一切正常、入口一直 502，这种「部署成功」最误导人。
  if knot_enabled KNOT_TUNNEL; then
    case "$(knot_origin_host "$KNOT_PUBLIC_ORIGIN")" in
      127.0.0.1 | localhost | "") ;;
      *)
        echo "==> probe ${KNOT_PUBLIC_ORIGIN}/api/health"
        public_ok=0
        # 部署本身会重启隧道，给它一点时间重连；不重试会把正常的重连当成故障。
        for _ in $(seq 1 15); do
          if curl -sf --noproxy '*' --max-time 5 "${KNOT_PUBLIC_ORIGIN}/api/health" >/dev/null 2>&1; then
            public_ok=1
            break
          fi
          sleep 2
        done
        if [[ "$public_ok" == 1 ]]; then
          echo "    公网入口可达。"
        else
          PUBLIC_UNREACHABLE=1
          knot_warn "公网入口打不通：${KNOT_PUBLIC_ORIGIN}/api/health。本机 Backend 是好的，问题在隧道或入口 nginx。"
          knot_warn "查：./ops/scripts/doctor.sh --site $KNOT_SITE"
        fi
        ;;
    esac
  fi
  # 走到这里新版本已经在跑、版本也对得上：后面 openclaw 之类的步骤再失败，
  # 不该把线上好好的版本回滚掉。
  DEPLOY_LIVE=1
else
  if [[ -n "$PREV_TARGET" && "$NO_ROLLBACK" != 1 ]]; then
    knot_warn "新版本没有通过探活，回滚到 $PREV_TARGET"
    RESCUE_DONE=1
    ln -sfn "$PREV_TARGET" "$KNOT_DEPLOY_ROOT/current"
    restart_backend
    if curl -sf --noproxy '*' "http://127.0.0.1:$KNOT_PORT/api/health" >/dev/null 2>&1; then
      knot_fail "新版本 $REL_NAME 未通过探活，已回滚到 ${PREV_TARGET}。看 var/log/knot-platform.err.log。"
    fi
    knot_fail "新版本未通过探活，回滚后仍不通。看 var/log/knot-platform.err.log。"
  fi
  knot_fail "Backend 没有在 127.0.0.1:$KNOT_PORT 起来。看 var/log/knot-platform.err.log。"
fi

# ---- 9. OpenClaw（可选） ----
# 旁路体检：只报告，不进退出码。这里再兜一次 || true——读这段代码的人
# 不该需要先知道被调用方是守规矩的。
openclaw_report() {
  chmod +x "$KNOT_APP_DIR/ops/scripts/openclaw-check.sh" 2>/dev/null || true
  "$KNOT_APP_DIR/ops/scripts/openclaw-check.sh" || true
}

# 同步这一步可能刚把「明确关闭」的标记清掉，下一次定时探测还在几分钟之后。
# 这里立刻跑一次，部署完控制台就有读数，而不是空着一块等人以为坏了。
openclaw_probe_now() {
  case "${RUNTIME:-}" in
    launchd) launchctl kickstart -k "gui/$(id -u)/$(knot_label openclaw-probe)" >/dev/null 2>&1 || true ;;
    *) ;;
  esac
}

openclaw_mode="$(printf '%s' "$KNOT_OPENCLAW" | tr '[:upper:]' '[:lower:]')"
case "$openclaw_mode" in
  0 | false | no | off)
    echo "==> KNOT_OPENCLAW=0，跳过 OpenClaw"
    # 明确关掉也要留下「这是有人关的」这条事实。没有它，运行时无法把
    # 「按配置关闭」和「探测从没跑过」分开，页面上就永远只是一个 unknown。
    mkdir -p "$KNOT_DEPLOY_ROOT/var/run" 2>/dev/null || true
    printf '{"state":"off","checkedAt":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$KNOT_DEPLOY_ROOT/var/run/openclaw-status.json" 2>/dev/null || true
    # 和探测写出的一样只给主人读：校验和看和它同一份约定，不靠 umask 定。
    chmod 600 "$KNOT_DEPLOY_ROOT/var/run/openclaw-status.json" 2>/dev/null || true
    ;;
  auto | "")
    if command -v openclaw >/dev/null 2>&1; then
      echo "==> openclaw"
      chmod +x "$KNOT_APP_DIR/ops/scripts/ensure-openclaw.sh"
      OPENCLAW_ENABLE_PROCESS=1 "$KNOT_APP_DIR/ops/scripts/ensure-openclaw.sh"
      openclaw_report
      openclaw_probe_now
    else
      echo "==> 未安装 openclaw，跳过（KNOT_OPENCLAW=auto）"
    fi
    ;;
  *)
    echo "==> openclaw"
    chmod +x "$KNOT_APP_DIR/ops/scripts/ensure-openclaw.sh"
    OPENCLAW_ENABLE_PROCESS=1 "$KNOT_APP_DIR/ops/scripts/ensure-openclaw.sh"
    openclaw_report
    openclaw_probe_now
    ;;
esac

# ---- 9.5 第一个内部 Agent + 首帖问候（总是执行，失败不阻断部署） ----
echo "==> ensure first agent"
chmod +x "$KNOT_APP_DIR/ops/scripts/ensure-first-agent.sh" 2>/dev/null || true
if "$KNOT_APP_DIR/ops/scripts/ensure-first-agent.sh"; then
  :
else
  knot_warn "第一个内部 Agent / 首帖问候没有完成，看上面输出。站点其余部分已就绪。"
fi

# ---- 10. 记录与清理 ----
cat >"$KNOT_DEPLOY_ROOT/deployed.json" <<JSON
{
  "site": "$KNOT_SITE",
  "release": "$REL_NAME",
  "version": "$REL_VERSION",
  "commit": "$REL_COMMIT",
  "platform": "$REL_PLATFORM",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "previous": "${PREV_TARGET:-}"
}
JSON

KEEP="$KNOT_DEPLOY_KEEP"
[[ "$KEEP" =~ ^[0-9]+$ ]] || KEEP=5
if (( KEEP > 0 )) && [[ -d "$KNOT_RELEASES_DIR" ]]; then
  CURRENT_TARGET="releases/$REL_NAME"
  # 按安装时间从新到旧，先保住最近 KEEP 个，再清剩下的（当前版本和上一个永远不删）。
  ls -1dt "$KNOT_RELEASES_DIR"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) |
    while IFS= read -r dir; do
      name="$(basename "$dir")"
      [[ "releases/$name" == "$CURRENT_TARGET" ]] && continue
      [[ "releases/$name" == "${PREV_TARGET:-}" ]] && continue
      echo "==> 清理旧发布包 $name"
      rm -rf "$dir"
    done || true
fi

# 发布包按同一份保留数清：只有已安装过的 tar.gz 才算冗余，没装过的是「待用」。
# 安装失败时 .incoming 会留下来，这里把超过一天的一并清掉。
if (( KEEP > 0 )) && [[ -d "$KNOT_DEPLOY_ROOT/artifacts" ]]; then
  ls -1t "$KNOT_DEPLOY_ROOT/artifacts"/*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) |
    while IFS= read -r file; do
      base="$(basename "$file")"
      # 当前版本对应的包先留着，下一轮再清。
      [[ "$base" == "${REL_NAME}"-*.tar.gz ]] && continue
      echo "==> 清理旧发布包 $(basename "$file")"
      rm -f "$file" "$file.sha256"
    done || true
fi
if [[ -d "$KNOT_DEPLOY_ROOT/.incoming" ]]; then
  find "$KNOT_DEPLOY_ROOT/.incoming" -mindepth 1 -maxdepth 1 -type d -mtime +1 -print -exec rm -rf {} + 2>/dev/null || true
fi

if [[ "$PUBLIC_UNREACHABLE" == 1 ]]; then
  echo "部分完成：本机已装好，公网入口现在打不通（隧道或入口 nginx）"
else
  echo "OK: $KNOT_PUBLIC_ORIGIN"
fi
echo "    版本 $REL_VERSION ($REL_COMMIT)  $REL_NAME"
echo "    本机 http://127.0.0.1:$KNOT_PORT"
[[ -n "$PREV_TARGET" ]] && echo "    回滚 $KNOT_DEPLOY_ROOT/current/ops/scripts/rollback.sh --site $KNOT_SITE"
