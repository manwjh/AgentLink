#!/usr/bin/env bash
# 把一个已经安装好的发布包切回 current，重启并探活。
#
# 只回滚代码。数据库迁移是向前的：新版本执行过的迁移不会撤销。
# 如果新版本已经写过新的迁移，旧代码可能读不懂新表，回滚前先看 migrate --status。
#
# 用法：
#   ./ops/scripts/rollback.sh --site wang --list
#   ./ops/scripts/rollback.sh --site wang              # 回到上一个版本
#   ./ops/scripts/rollback.sh --site wang --to knot-0.1.9-abc1234
#   ./ops/scripts/rollback.sh --site wang --dry-run
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

SITE_ARG=""
TARGET_ARG=""
LIST_ONLY=0
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--site 后面要跟站点名" >&2; exit 2; }
      SITE_ARG="$2"
      shift 2
      ;;
    --to)
      [[ $# -ge 2 && -n "${2:-}" ]] || { echo "--to 后面要跟发布包名" >&2; exit 2; }
      TARGET_ARG="$2"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
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
# platform.env 里有部署时记下的 KNOT_NODE_BIN：回滚脚本也要用它读 JSON，
# 不能依赖调用者 PATH 里恰好有 node（ssh 非登录 shell、launchd 都没有）。
knot_source_platform_env
NODE_BIN="${KNOT_NODE_BIN:-node}"

CURRENT_LINK="$KNOT_DEPLOY_ROOT/current"
CURRENT_TARGET="$(readlink "$CURRENT_LINK" 2>/dev/null || true)"
CURRENT_NAME="${CURRENT_TARGET#releases/}"

if [[ "$LIST_ONLY" == 1 ]]; then
  echo "部署根 $KNOT_DEPLOY_ROOT"
  echo "当前   ${CURRENT_NAME:-（未安装）}"
  if [[ -d "$KNOT_RELEASES_DIR" ]]; then
    find "$KNOT_RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d ! -name '.*' | sort -r | while IFS= read -r dir; do
      name="$(basename "$dir")"
      if [[ "$name" == "$CURRENT_NAME" ]]; then
        echo "  * $name"
      else
        echo "    $name"
      fi
    done
  fi
  exit 0
fi

[[ -n "$CURRENT_NAME" ]] || knot_fail "还没有安装过，current 不存在。先跑 deploy-site.sh。"

if [[ -n "$TARGET_ARG" ]]; then
  TARGET_NAME="$TARGET_ARG"
  if [[ ! -d "$KNOT_RELEASES_DIR/$TARGET_NAME" ]]; then
    MATCHES="$(find "$KNOT_RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d -name "*$TARGET_ARG*" -exec basename {} \; 2>/dev/null || true)"
    COUNT="$(printf '%s\n' "$MATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [[ "$COUNT" == "1" ]]; then
      TARGET_NAME="$MATCHES"
    elif [[ "$COUNT" == "0" ]]; then
      knot_fail "找不到发布包：${TARGET_ARG}。用 --list 看已安装的版本。"
    else
      knot_fail "$TARGET_ARG 匹配到多个发布包：$(printf '%s' "$MATCHES" | tr '\n' ' ')"
    fi
  fi
else
  # deployed.json 里记着这次部署之前的版本，优先用它。
  PREV=""
  if [[ -f "$KNOT_DEPLOY_ROOT/deployed.json" ]]; then
    PREV="$("$NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).previous || "")) } catch {}' "$KNOT_DEPLOY_ROOT/deployed.json")"
  fi
  TARGET_NAME="${PREV#releases/}"
  if [[ -z "$TARGET_NAME" ]]; then
    # 没有记录时退回时间上第二新的那个。
    TARGET_NAME="$(find "$KNOT_RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d ! -name '.*' -exec basename {} \; | sort -r | grep -v -x "$CURRENT_NAME" | head -n 1 || true)"
  fi
  [[ -n "$TARGET_NAME" ]] || knot_fail "只有一个发布包，没有可回滚的版本。"
fi

[[ "$TARGET_NAME" == "$CURRENT_NAME" ]] && knot_fail "$TARGET_NAME 已经是当前版本。"
[[ -d "$KNOT_RELEASES_DIR/$TARGET_NAME" ]] || knot_fail "发布包目录不存在：$KNOT_RELEASES_DIR/$TARGET_NAME"

echo "==> current: $CURRENT_NAME → $TARGET_NAME"
if [[ "$DRY_RUN" == 1 ]]; then
  echo "dry-run：没有改动。"
  exit 0
fi

# 只换 current，不重写 platform.env：那份里的 STATIC_WEB_DIR 写成经 current 的路径，
# 换链接就跟着换了版本。
ln -sfn "releases/$TARGET_NAME" "$CURRENT_LINK"

# 用哪种运行时，先看装过什么（LaunchAgent 是明确的证据），最后才按 var/run
# 里的 pid 文件推断。反过来做的话，残留的 pid 文件会让脚本去 kill 一个不存在的
# pid，而真正在跑的服务没被重启——current 换了，进程还是旧的。
restart_backend() {
  local pid_file="$KNOT_DEPLOY_ROOT/var/run/backend.pid"
  local unit
  unit="$(knot_label platform)"
  if [[ -f "$HOME/Library/LaunchAgents/$unit.plist" ]]; then
    local uid_num
    uid_num="$(id -u)"
    launchctl kickstart -k "gui/$uid_num/$unit" 2>/dev/null || true
    return 0
  fi
  if [[ -f "$pid_file" ]]; then
    restart_manual
    return 0
  fi
  local uid_num
  uid_num="$(id -u)"
  launchctl kickstart -k "gui/$uid_num/$unit" 2>/dev/null || true
}

# 没有服务管理器时（deploy-site.sh --runtime none）由部署根下的 pid 文件管进程。
restart_manual() {
  local pid_file="$KNOT_DEPLOY_ROOT/var/run/backend.pid"
  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      kill "$old_pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
    rm -f "$pid_file"
  fi
  mkdir -p "$KNOT_DEPLOY_ROOT/var/log" "$KNOT_DEPLOY_ROOT/var/run"
  # 和 deploy-site.sh 一样用干净环境启动，只认 platform.env；同样要脱离调用者的进程组。
  knot_start_detached "$pid_file" "$KNOT_DEPLOY_ROOT/var/log/knot-platform.log" \
    env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
    KNOT_SITE="$KNOT_SITE" KNOT_DEPLOY_ROOT="$KNOT_DEPLOY_ROOT" \
    "$KNOT_DEPLOY_ROOT/current/ops/scripts/run-knot-platform.sh"
  for _ in $(seq 1 50); do
    [[ -s "$pid_file" ]] && break
    sleep 0.1
  done
}

wait_healthy() {
  local bound="${1:-30}"
  local _
  for _ in $(seq 1 "$bound"); do
    if curl -sf --noproxy '*' "http://127.0.0.1:$KNOT_PORT/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restart_backend

if ! wait_healthy 30; then
  # 回滚也可能落在一个坏版本上（另一个版本同样起不来）。那时切回原版本再试一次，
  # 至少回到回滚之前的状态。
  knot_warn "回滚到 ${TARGET_NAME} 后后端没有起来，切回 ${CURRENT_NAME}。"
  ln -sfn "releases/$CURRENT_NAME" "$CURRENT_LINK"
  restart_backend || true
  if wait_healthy 30; then
    knot_fail "回滚到 ${TARGET_NAME} 失败（后端没起来），已切回 ${CURRENT_NAME}。看 $KNOT_DEPLOY_ROOT/var/log/knot-platform.err.log"
  fi
  knot_fail "回滚到 ${TARGET_NAME} 失败，切回 ${CURRENT_NAME} 后仍不通。current 现在是 ${CURRENT_NAME}；看 $KNOT_DEPLOY_ROOT/var/log/knot-platform.err.log"
fi

BUILD_INFO="$KNOT_RELEASES_DIR/$TARGET_NAME/BUILD.json"
REL_VERSION=""
REL_COMMIT=""
REL_PLATFORM=""
if [[ -f "$BUILD_INFO" ]]; then
  REL_VERSION="$("$NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version || "")) } catch {}' "$BUILD_INFO")"
  REL_COMMIT="$("$NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).commit || "")) } catch {}' "$BUILD_INFO")"
  REL_PLATFORM="$("$NODE_BIN" -e 'try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).platform || "")) } catch {}' "$BUILD_INFO")"
fi
cat >"$KNOT_DEPLOY_ROOT/deployed.json" <<JSON
{
  "site": "$KNOT_SITE",
  "release": "$TARGET_NAME",
  "version": "$REL_VERSION",
  "commit": "$REL_COMMIT",
  "platform": "$REL_PLATFORM",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "previous": "releases/$CURRENT_NAME",
  "rolledBack": true
}
JSON

echo "OK: 已回滚到 $TARGET_NAME"
echo "    数据库迁移没有回滚；必要时用 migrate.js --status 查看。"
