#!/usr/bin/env bash
# 从开发机构建发布包，传到实例主机，在那边安装。
#
# 只传构建产物，不传源码：目标机不跑 npm ci，不跑 vite build。
# 目标主机、目录和私钥来自 sites/<站点>/site.env。
#
# 用法：
#   ./ops/scripts/push-deploy.sh --site local               # local：本机整套系统，不 ssh
#   ./ops/scripts/push-deploy.sh --site wang                # xknot.si 子域：装实例主机
#   ./ops/scripts/push-deploy.sh --site wang --no-build    # 用本地最新的发布包
#   ./ops/scripts/push-deploy.sh --site wang --artifact artifacts/knot-0.2.0-abc1234-darwin-arm64.tar.gz
#   ./ops/scripts/push-deploy.sh --site wang --bootstrap   # 先让目标机补 Node/Postgres，再部署
#   ./ops/scripts/push-deploy.sh --site wang --dry-run     # 只检查，不动目标机
#   ./ops/scripts/push-deploy.sh --site local --runtime none # local，且不装成开机自启
#
# KNOT_DEPLOY_SSH 留空表示目标就是这台机器：构建、解包、装服务、探活都在本地做完，
# 不 ssh、不 scp。部署根取 KNOT_DEPLOY_DIR（和仓库分开）；没配时才退回仓库本身。
#
# 两种常用形态，验收标准就是这两条：
#   A. 在 macOS 实例主机上跑（KNOT_DEPLOY_SSH 为空）：本机构建 + 本机安装。
#   B. 在另一台机器上跑，经 ssh 让 A 机安装：构建在 B，探活回到 A 的回环地址上做。
#      —— B 必须与 A 同平台同架构（原生模块不跨平台）；B 不是 macOS 时，把一台
#      macOS 上打好的包用 --artifact 传进来，别在这台机器上构建。
#
# 部署、探活、失败回滚都只在目标机上动；B 机不保存任何站点数据。
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

SITE_ARG=""
ARTIFACT_ARG=""
BUILD=1
SKIP_TEST=0
DRY_RUN=0
RUNTIME_ARG=""
BOOTSTRAP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--site 后面要跟站点名" >&2; exit 2; }
      SITE_ARG="$2"
      shift 2
      ;;
    --artifact)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--artifact 后面要跟 tar.gz" >&2; exit 2; }
      ARTIFACT_ARG="$2"
      shift 2
      ;;
    --no-build)
      BUILD=0
      shift
      ;;
    --skip-test)
      SKIP_TEST=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --bootstrap)
      BOOTSTRAP=1
      shift
      ;;
    --runtime)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--runtime 后面要跟 launchd / none" >&2; exit 2; }
      case "$2" in
        launchd | none) RUNTIME_ARG="$2" ;;
        *) echo "--runtime 只接受 launchd / none，现在是 $2（实例主机只支持 macOS + launchd）" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done
[[ -n "$SITE_ARG" ]] && export KNOT_SITE="$SITE_ARG"

# shellcheck source=lib/site-config.sh
source "$SCRIPT_DIR/lib/site-config.sh"
# shellcheck source=lib/artifact-guard.sh
source "$SCRIPT_DIR/lib/artifact-guard.sh"
# shellcheck source=lib/ssh-args.sh
source "$SCRIPT_DIR/lib/ssh-args.sh"

knot_require KNOT_PUBLIC_ORIGIN "在 sites/$KNOT_SITE/site.env 里写 KNOT_PUBLIC_ORIGIN。"

# KNOT_DEPLOY_SSH 留空 = 目标就是这台机器。开发者的 local 站点用它：
# 构建后直接就地安装，不走 ssh/scp。部署根取 KNOT_DEPLOY_DIR。
LOCAL_DEPLOY=0
if [[ -z "${KNOT_DEPLOY_SSH:-}" ]]; then
  LOCAL_DEPLOY=1
fi

# 先在开发机校验一遍，别把错的配置运到实例主机再回滚。
echo "==> config sites/$KNOT_SITE/site.env"
CHECK_ARGS=(--site "$KNOT_SITE")
node "$SCRIPT_DIR/config.mjs" check "${CHECK_ARGS[@]}"

# ---- 1. 发布包 ----
if [[ -z "$ARTIFACT_ARG" ]]; then
  if [[ "$BUILD" == 1 ]]; then
    BUILD_ARGS=(--out "$KNOT_ARTIFACT_DIR")
    [[ "$SKIP_TEST" == 1 ]] && BUILD_ARGS+=(--skip-test)
    "$SCRIPT_DIR/build.sh" "${BUILD_ARGS[@]}"
  fi
  ARTIFACT_ARG="$(node "$SCRIPT_DIR/artifact.mjs" latest "$KNOT_ARTIFACT_DIR")"
fi
[[ -f "$ARTIFACT_ARG" ]] || knot_fail "找不到发布包：$ARTIFACT_ARG"
ARTIFACT_DIR="$(cd "$(dirname "$ARTIFACT_ARG")" && pwd)"
ARTIFACT="$ARTIFACT_DIR/$(basename "$ARTIFACT_ARG")"
node "$SCRIPT_DIR/artifact.mjs" verify "$ARTIFACT" >/dev/null || knot_fail "发布包校验失败：$ARTIFACT"
# 校验和是自家签的，证明不了包里的路径。远端解包写的是部署根，先看成员名单（S16-01）。
knot_check_tar_members "$ARTIFACT" || knot_fail "发布包里有会写到部署根之外的成员：$ARTIFACT"

PLATFORM="$(node "$SCRIPT_DIR/artifact.mjs" platform)"
ARTIFACT_BASE="$(basename "$ARTIFACT")"
case "$ARTIFACT_BASE" in
  *-"$PLATFORM".tar.gz) REL_NAME="${ARTIFACT_BASE%-"$PLATFORM".tar.gz}" ;;
  *) knot_fail "发布包名对不上这台机器的平台（${PLATFORM}）：$ARTIFACT_BASE" ;;
esac

# ---- 2. 本机安装（KNOT_DEPLOY_SSH 为空）----
if [[ "$LOCAL_DEPLOY" == 1 ]]; then
  # 部署根和仓库分开：仓库只放源码与站点配置稿，releases/、current、var/ 落在部署根。
  # 没写 KNOT_DEPLOY_DIR 时退回旧行为（部署根 = 仓库），只给临时调试用。
  DEPLOY_DIR="$(knot_expand_path "${KNOT_DEPLOY_DIR:-$APP}")"
  VERIFY_URL="${KNOT_DEPLOY_VERIFY_URL:-http://127.0.0.1:$KNOT_PORT/api/health}"

  echo "==> $REL_NAME  $PLATFORM"
  echo "    → 本机 $DEPLOY_DIR"

  if [[ "$DRY_RUN" == 1 ]]; then
    echo
    echo "dry-run：本地检查通过，没有改动任何文件。"
    echo "  发布包  $ARTIFACT"
    echo "  部署根  $DEPLOY_DIR"
    echo "  装到    $DEPLOY_DIR/releases/$REL_NAME"
    echo "  探活    $VERIFY_URL"
    echo "  运行时  ${RUNTIME_ARG:-launchd}"
    [[ "$BOOTSTRAP" == 1 ]] && echo "  引导    --bootstrap：门禁不过时先装 Node 22+ / postgresql@16"
    exit 0
  fi

  echo "==> install"
  # 站点配置属于这台机器，不进发布包：先落到部署根，deploy-site.sh 从部署根读它。
  # 部署根还等于仓库时（没配 KNOT_DEPLOY_DIR）不要把自己截断。
  mkdir -p "$DEPLOY_DIR/artifacts" "$DEPLOY_DIR/sites/$KNOT_SITE"
  chmod 700 "$DEPLOY_DIR/sites/$KNOT_SITE"
  if [[ "$(cd "$DEPLOY_DIR/sites/$KNOT_SITE" && pwd -P)" != "$(cd "$KNOT_SITE_DIR" && pwd -P)" ]]; then
    cp "$KNOT_SITE_ENV" "$DEPLOY_DIR/sites/$KNOT_SITE/site.env"
    chmod 600 "$DEPLOY_DIR/sites/$KNOT_SITE/site.env"
    # 隧道参数由中枢开通时写在这一侧。部署根还没有这一份时才带过去：开通流程
    # 写的那份是活的，用仓库里的副本覆盖会换掉正在用的账号或端口。
    if [[ -f "$KNOT_SITE_DIR/tunnel.env" && ! -f "$DEPLOY_DIR/sites/$KNOT_SITE/tunnel.env" ]]; then
      cp "$KNOT_SITE_DIR/tunnel.env" "$DEPLOY_DIR/sites/$KNOT_SITE/tunnel.env"
      chmod 600 "$DEPLOY_DIR/sites/$KNOT_SITE/tunnel.env"
    fi
  fi
  DEPLOY_ARGS=(--site "$KNOT_SITE" --deploy-root "$DEPLOY_DIR" --artifact "$ARTIFACT")
  [[ -n "$RUNTIME_ARG" ]] && DEPLOY_ARGS+=(--runtime "$RUNTIME_ARG")
  # 补装交给目标机上的 deploy-site.sh：它就在发布包目录里跑，能拿到同一份
  # host-check 与 bootstrap-host.sh，不用把脚本管道喂过去。
  [[ "$BOOTSTRAP" == 1 ]] && DEPLOY_ARGS+=(--bootstrap)
  "$SCRIPT_DIR/deploy-site.sh" "${DEPLOY_ARGS[@]}"

  echo "==> verify $VERIFY_URL"
  verified=0
  for _ in $(seq 1 30); do
    if curl -sf --noproxy '*' "$VERIFY_URL" >/dev/null 2>&1; then
      verified=1
      break
    fi
    sleep 1
  done
  if [[ "$verified" != 1 ]]; then
    knot_fail "健康检查没有通过：${VERIFY_URL}。看 $DEPLOY_DIR/var/log/ 里的日志。"
  fi
  curl -sf --noproxy '*' -o /dev/null -w "web %{http_code}\n" "http://127.0.0.1:$KNOT_PORT/"

  echo "OK: $KNOT_PUBLIC_ORIGIN"
  echo "    $REL_NAME"
  echo "    本机 http://127.0.0.1:$KNOT_PORT"
  echo "    登录：./ops/scripts/local-login.sh --site $KNOT_SITE"
  exit 0
fi

# ---- 3. 连目标机 ----
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
PUBLISH_KEY="$(knot_expand_path "$KNOT_DEPLOY_SSH_KEY")"
if [[ -n "$PUBLISH_KEY" ]]; then
  SSH_OPTS+=(-i "$PUBLISH_KEY")
fi

PASS="${DEPLOY_SSH_PASS:-${E2E_SSH_PASS:-${SSHPASS:-}}}"
if [[ -n "$PASS" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    knot_fail "需要 sshpass：brew install sshpass"
  fi
  export SSHPASS="$PASS"
  SSH_OPTS+=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPrompts=1)
  RSYNC_E="sshpass -e ssh ${SSH_OPTS[*]}"
  RUN_SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
else
  RSYNC_E="ssh ${SSH_OPTS[*]}"
  RUN_SSH=(ssh "${SSH_OPTS[@]}")
fi

# 把本机展开过的 ~ 换成目标机的 home。配置里的 `~` 在被 source 时
# 会先展开成本机 home，直接当远端路径会写到不存在的地方。
DEPLOY_DIR="$KNOT_DEPLOY_DIR"
# 取最后一行：登录 banner 会混进 stdout，整段当路径会把命令发到奇怪的地方。
REMOTE_HOME="$("${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" 'printf %s "$HOME"' | tail -n 1)"
case "$REMOTE_HOME" in
  /*) ;;
  *)
    knot_fail "目标机返回的 home 不是绝对路径：'${REMOTE_HOME}'。检查 ssh 登录 banner 或 shell 启动脚本的输出。"
    ;;
esac
case "$DEPLOY_DIR" in
  "~") DEPLOY_DIR="$REMOTE_HOME" ;;
  "~/"*) DEPLOY_DIR="$REMOTE_HOME/${DEPLOY_DIR#\~/}" ;;
  "$HOME") DEPLOY_DIR="$REMOTE_HOME" ;;
  "$HOME"/*) DEPLOY_DIR="$REMOTE_HOME${DEPLOY_DIR#"$HOME"}" ;;
esac

# 部署前的版本：健康检查失败时用它把远端切回去。取值走位置参数，
# 不拼进远端 shell 文本。
PREV_REMOTE="$("${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" bash -s -- "$(knot_shq "$DEPLOY_DIR")" <<'REMOTE' | tail -n 1
set -eu
readlink "$1/current" 2>/dev/null || true
REMOTE
)"

# 目标机的平台标签。构建在 B、安装在 A：原生模块（如 sharp）不跨平台，
# 包名里的平台标签必须和 A 对得上，否则等 tar 传完 100MB 才在解包后失败。
read -r TARGET_SYS TARGET_ARCH <<<"$("${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" 'uname -s; uname -m' | tail -n 2 | tr '\n' ' ')"
case "${TARGET_SYS}/${TARGET_ARCH}" in
  Darwin/arm64 | Darwin/aarch64) TARGET_PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) TARGET_PLATFORM="darwin-x64" ;;
  *)
    knot_fail "目标机是 ${TARGET_SYS:-?}/${TARGET_ARCH:-?}：实例主机只支持 macOS（main 分支）。
要支持别的平台是 fork 的事，见 ops/README「支持范围与 fork 接缝」。"
    ;;
esac
if [[ "$TARGET_PLATFORM" != "$PLATFORM" ]]; then
  knot_fail "发布包是 ${PLATFORM}，目标机是 ${TARGET_PLATFORM}。
在这台机器（$(uname -s)/$(uname -m)）上构建的包只能在同平台同架构的实例主机上用：
  1. 到一台 macOS ${TARGET_ARCH} 上构建，再用 --no-build 或 --artifact 传这个包；
  2. 或者直接在那台机器上跑 push-deploy.sh（KNOT_DEPLOY_SSH 留空）。"
fi

echo "==> $REL_NAME  $PLATFORM"
echo "    → $KNOT_DEPLOY_SSH:$DEPLOY_DIR"

if [[ "$DRY_RUN" == 1 ]]; then
  echo
  echo "dry-run：本地检查通过，没有改动目标机。"
  echo "  发布包  $ARTIFACT"
  echo "  目标    $KNOT_DEPLOY_SSH:$DEPLOY_DIR/releases/$REL_NAME"
  echo "  平台    ${TARGET_PLATFORM}（目标机）"
  echo "  运行时  ${RUNTIME_ARG:-launchd}"
  [[ "$BOOTSTRAP" == 1 ]] && echo "  引导    --bootstrap：门禁不过时先装 Node 22+ / postgresql@16"
  exit 0
fi

# ---- 4. 传发布包和站点配置 ----
"${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" "mkdir -p '$DEPLOY_DIR/artifacts' '$DEPLOY_DIR/.incoming' '$DEPLOY_DIR/sites/$KNOT_SITE' && chmod 700 '$DEPLOY_DIR/sites/$KNOT_SITE'"

echo "==> upload artifact"
rsync -az -e "$RSYNC_E" "$ARTIFACT" "$ARTIFACT.sha256" "$KNOT_DEPLOY_SSH:$DEPLOY_DIR/artifacts/"

# 站点配置不进发布包：它属于这台机器，而且 platform.env 里有密钥。
# 先建一个 600 的空文件再写：`cat > file && chmod 600` 之间文件按 umask（通常 644）
# 存在，里面的 DATABASE_URL 与委托发信令牌在这段时间对同机其他用户可读。
REMOTE_SITE="sites/$KNOT_SITE"
echo "==> site → $KNOT_DEPLOY_SSH:$DEPLOY_DIR/$REMOTE_SITE/site.env"
"${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" "install -m 600 /dev/null '$DEPLOY_DIR/$REMOTE_SITE/site.env' && cat > '$DEPLOY_DIR/$REMOTE_SITE/site.env'" <"$KNOT_SITE_ENV"

# 隧道参数与私钥同在 sites/<站点>/tunnel.env：它决定目标机装不装隧道单元、
# 探不探公网入口，也决定账号与端口。目标机还没有这一份时才传过去——开通流程
# 在实例上写的那份是活的，开发机上的副本可能停在签发那一刻，用它覆盖会换掉
# 正在用的账号或端口。
if [[ -f "$KNOT_SITE_DIR/tunnel.env" ]]; then
  if "${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" "test -f '$DEPLOY_DIR/$REMOTE_SITE/tunnel.env'"; then
    echo "==> 目标机已有 $REMOTE_SITE/tunnel.env，保留（以开通流程写的那份为准）"
  else
    echo "==> site → $KNOT_DEPLOY_SSH:$DEPLOY_DIR/$REMOTE_SITE/tunnel.env"
    "${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" "install -m 600 /dev/null '$DEPLOY_DIR/$REMOTE_SITE/tunnel.env' && cat > '$DEPLOY_DIR/$REMOTE_SITE/tunnel.env'" <"$KNOT_SITE_DIR/tunnel.env"
  fi
fi

# ---- 5. 在目标机解包并安装 ----
echo "==> remote install"
# 远端脚本固定走 stdin，值全部用位置参数传：发布包名来自文件名，含一个单引号
# 就能在实例主机上跳出引号、以部署用户执行任意命令，紧接着还是 rm -rf。
# 解包目录也改成 mktemp：同一主机并发部署时不再共用 .incoming/<名字>。
#
# 每个值都过一道 knot_shq（见 lib/ssh-args.sh）：ssh 只用空格把 argv 拼成一条
# 命令串，远端 shell 重新拆词。不引号的话，没带 --runtime 时的空串会整个消失，
# 后面的值逐位前移——`--bootstrap` 掉进 --runtime 的位置，看起来像开关没生效。
REMOTE_ARGS=()
for value in "$DEPLOY_DIR" "$REL_NAME" "$ARTIFACT_BASE" "$KNOT_SITE" "${RUNTIME_ARG:-}" "$BOOTSTRAP"; do
  REMOTE_ARGS+=("$(knot_shq "$value")")
done
"${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" bash -s -- "${REMOTE_ARGS[@]}" <<'REMOTE'
set -eu
deploy_dir="$1"
rel_name="$2"
artifact="$3"
site="$4"
# 空串是「没带 --runtime」，由 deploy-site.sh 按默认 launchd 处理。
runtime="${5:-}"
bootstrap="${6:-0}"
# 不是 launchd / none 就说明位置参数又错位了：说清是哪种错位，别让 deploy-site.sh
# 报一句「--runtime 只能是 launchd 或 none」然后让人去猜为什么。
case "$runtime" in
  "" | launchd | none) ;;
  *)
    echo "远程部署参数错位：第 5 个参数应是 launchd / none / 空，实际收到 '${runtime}'。" >&2
    echo "这通常是 ssh 把某个空参数吃掉、后面的值逐位前移造成的，见 push-deploy.sh 里 knot_shq 那段说明。" >&2
    exit 2
    ;;
esac

case "$rel_name" in
  "" | */* | *..*) echo "发布包名不合法：${rel_name}" >&2; exit 2 ;;
esac
incoming="$(mktemp -d "${deploy_dir}/.incoming/knot-XXXXXX")"
trap 'rm -rf "$incoming"' EXIT
# --no-same-owner：包里的 uid/gid 不该落到部署机上；成员路径已在本地校验过。
tar -xzf "${deploy_dir}/artifacts/${artifact}" -C "$incoming" --no-same-owner
args=(--site "$site" --deploy-root "$deploy_dir")
[ -n "$runtime" ] && args+=(--runtime "$runtime")
# 补装由目标机上的 deploy-site.sh 自己调 bootstrap-host.sh：脚本就在刚解开的
# 发布包里，不靠管道喂过去（管道执行时 $0 是 bash，找不到 lib/）。
[ "$bootstrap" = "1" ] && args+=(--bootstrap)
KNOT_DEPLOY_ROOT="$deploy_dir" "${incoming}/${rel_name}/ops/scripts/deploy-site.sh" "${args[@]}"
REMOTE

# ---- 6. 验收 ----
# 实例默认只监听 127.0.0.1：从 B 直连 A 的 KNOT_PORT 会连不上，那样一次成功的
# 部署会被读成「新版坏了」并自动回滚。所以没配 KNOT_DEPLOY_VERIFY_URL 时，探活
# 回到目标机的回环地址上做。只有显式配了地址（通常是公网入口）才从 B 验。
VERIFY_URL="$KNOT_DEPLOY_VERIFY_URL"
VERIFY_ON_TARGET="$([[ -n "$VERIFY_URL" ]] && echo 0 || echo 1)"
if [[ "$VERIFY_ON_TARGET" == 1 ]]; then
  VERIFY_URL="http://127.0.0.1:$KNOT_PORT/api/health（在目标机上）"
fi

# 远端 curl 的退出码与正文一起交回：只看正文分不清 404 和「连不上」。
remote_code() {
  "${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" \
    "curl -sf --noproxy '*' -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$KNOT_PORT$1'" 2>/dev/null | tail -n 1
}

verify_ok() {
  if [[ "$VERIFY_ON_TARGET" == 1 ]]; then
    [[ "$(remote_code /api/health)" == "200" ]]
  else
    curl -sf --noproxy '*' "$VERIFY_URL" >/dev/null 2>&1
  fi
}

# 验收一律直连，不看本机代理设置：这一步不过会自动回滚，代理一次抖动就会被读成
# 「新版本坏了」，代价是白回滚一次线上版本。KNOT_DEPLOY_VERIFY_URL 允许指向公网
# 入口，那条路经过代理更慢更不稳，正是最容易误判的一种配法。
echo "==> verify $VERIFY_URL"
verified=0
for _ in $(seq 1 30); do
  if verify_ok; then
    verified=1
    break
  fi
  sleep 1
done
if [[ "$verified" != 1 ]]; then
  # 远端已经切了 current，健康检查不过就是 502 一直挂着等人手工回滚。
  # 部署前记下的版本还可用就自动切回去，别把线上停在坏版本。
  PREV_NAME="${PREV_REMOTE#releases/}"
  if [[ -n "$PREV_NAME" && "$PREV_NAME" != "$REL_NAME" ]]; then
    echo "==> 健康检查没过，远端回滚到 ${PREV_NAME}" >&2
    "${RUN_SSH[@]}" "$KNOT_DEPLOY_SSH" bash -s -- \
      "$(knot_shq "$DEPLOY_DIR")" "$(knot_shq "$KNOT_SITE")" "$(knot_shq "$PREV_NAME")" <<'REMOTE' || true
set -eu
deploy_dir="$1"
site="$2"
target="$3"
KNOT_DEPLOY_ROOT="$deploy_dir" "$deploy_dir/current/ops/scripts/rollback.sh" --site "$site" --to "$target"
REMOTE
    for _ in $(seq 1 15); do
      if verify_ok; then
        knot_fail "新版本 ${REL_NAME} 没有通过健康检查，已回滚到 ${PREV_NAME}（现在可达）。看 $DEPLOY_DIR/var/log/。"
      fi
      sleep 1
    done
    knot_fail "新版本 ${REL_NAME} 没有通过健康检查，回滚到 ${PREV_NAME} 后仍不可达：${VERIFY_URL}。"
  fi
  knot_fail "健康检查没有通过：$VERIFY_URL"
fi
echo "web $(remote_code /)"
echo "OK: $KNOT_PUBLIC_ORIGIN"
echo "    $REL_NAME"
echo "    实例主机 ${KNOT_DEPLOY_SSH#*@} 上的 127.0.0.1:${KNOT_PORT}（在本机验，不经内网直连）"
