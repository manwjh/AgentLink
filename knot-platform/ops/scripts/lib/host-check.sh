#!/usr/bin/env bash
# 主机就绪检查：只检查、不改系统。
#
# 三处共用这一份判定，不各写一套：
#   deploy-site.sh     安装前的硬门禁（任何写操作之前）
#   doctor.sh          体检多三行：平台、Node、库配置
#   bootstrap-host.sh  装完复跑同一套判定，确认真的过了
#
# 设计约束（都是有代价换来的）：
#   * 不改系统：这里只读，装包是 bootstrap-host.sh 的事，而且要人显式加 --yes。
#   * 不读 stdin：push-deploy.sh 经 `ssh … bash -s <<'REMOTE'` 调用部署脚本，
#     stdin 就是那份脚本本身；任何 read 都会把脚本剩下的行吃掉。
#   * 失败给一行命令：只说「缺 node」等于把问题丢回去，得给出可照做的下一条命令。
#
# 目标机只支持 macOS + launchd（main 分支）。要支持别的平台是 fork 的事，
# 见 ops/README「支持范围与 fork 接缝」；这里不做 --runtime 抽象。

KNOT_PF_FAILED=0
KNOT_PF_WARNED=0
KNOT_PF_FIXES=""
# 部署脚本与 doctor 会打开它：失败时多打一行 bootstrap 指引。
KNOT_PF_BOOTSTRAP_HINT="${KNOT_PF_BOOTSTRAP_HINT:-0}"

knot_pf_begin() {
  KNOT_PF_FAILED=0
  KNOT_PF_WARNED=0
  KNOT_PF_FIXES=""
}

# knot_pf_row <ok|warn|fail> <名称> <说明> [一行修复命令]
knot_pf_row() {
  local mark="$1" name="$2" detail="$3" fix="${4:-}"
  case "$mark" in
    ok) printf '  ok    %-12s %s\n' "$name" "$detail" ;;
    warn)
      KNOT_PF_WARNED=1
      printf '  warn  %-12s %s\n' "$name" "$detail"
      ;;
    *)
      KNOT_PF_FAILED=1
      printf '  FAIL  %-12s %s\n' "$name" "$detail"
      ;;
  esac
  if [[ -n "$fix" ]]; then
    # warn 不拦部署，后面不会打印修复清单：那就当场跟着这一行说出来，
    # 否则提示的「该改成什么」在门禁通过时直接丢掉。
    if [[ "$mark" == "warn" ]]; then
      printf '        %s\n' "$fix"
    else
      KNOT_PF_FIXES="${KNOT_PF_FIXES}${KNOT_PF_FIXES:+$'\n'}    ${fix}"
    fi
  fi
}

# 有任何 FAIL 就以非零返回；WARN 不拦。
# 第二个参数覆盖 bootstrap 提示：端口冲突这类失败装包解决不了，给那行只会误导。
knot_pf_finish() {
  local title="${1:-主机}"
  local hint="${2:-$KNOT_PF_BOOTSTRAP_HINT}"
  (( KNOT_PF_FAILED == 0 )) && return 0
  echo
  echo "${title}还没准备好，先补齐下面这些："
  printf '%s\n' "$KNOT_PF_FIXES"
  if [[ "$hint" == "1" ]]; then
    echo
    echo "  也可以让脚本装（只装 Node 与 postgresql@16，不建库、不改端口、不装系统服务）："
    echo "    ./ops/scripts/bootstrap-host.sh --site ${KNOT_SITE:-<站点>} --plan   # 先看它要做什么"
    echo "    ./ops/scripts/bootstrap-host.sh --site ${KNOT_SITE:-<站点>} --yes    # 确认后执行"
  fi
  return 1
}

knot_brew_bin() {
  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [[ -x "$candidate" ]] && printf '%s' "$candidate" && return 0
  done
  printf 'brew'
}

# ---- 平台 ----
# 实例主机跑 Backend + PostgreSQL + 上传目录，main 只支持 macOS。
# 入口主机（Linux + nginx）不在这条判定里：它由中枢维护，不跑 Knot。
knot_check_host_platform() {
  local system
  system="$(uname -s)"
  case "$system" in
    Darwin) knot_pf_row ok "平台" "macOS $(sw_vers -productVersion 2>/dev/null || uname -r) ($(uname -m))" ;;
    *)
      knot_pf_row fail "平台" "不支持 ${system}：实例主机只支持 macOS + launchd" \
        "要在这台机器上跑，先 fork 出对应平台的发布层，见 ops/README「支持范围与 fork 接缝」。"
      return 1
      ;;
  esac
}

# ---- 基础工具 ----
# tar/rsync/curl 在装到一半才缺，表现是「装完了但探活失败、白回滚一次」。
knot_check_tools() {
  local tool missing=""
  for tool in tar rsync curl mktemp; do
    command -v "$tool" >/dev/null 2>&1 || missing="${missing}${missing:+ }${tool}"
  done
  if [[ -z "$missing" ]]; then
    knot_pf_row ok "基础工具" "tar rsync curl mktemp"
  else
    knot_pf_row fail "基础工具" "缺 ${missing}" \
      "$(knot_brew_bin) install ${missing%% *}   # 装完重跑"
    return 1
  fi
}

# ---- Node ----
# 只认 22+，并且要拿到一个绝对路径：launchd 不跑登录 shell，PATH 里常常只有
# /usr/bin:/bin:/usr/sbin:/sbin。/opt/homebrew/bin 是 brew 的默认位置，nvm/fnm/volta
# 装在 home 下，也要能找得到——把路径记进 platform.env（KNOT_NODE_BIN），
# 服务的启动脚本就是用它，而不去猜 PATH。
knot_node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null || true
}

knot_node_candidates() {
  local bin
  [[ -n "${KNOT_NODE_BIN:-}" ]] && printf '%s\n' "$KNOT_NODE_BIN"
  bin="$(command -v node 2>/dev/null || true)"
  [[ -n "$bin" ]] && printf '%s\n' "$bin"
  for bin in \
    /opt/homebrew/bin/node \
    /opt/homebrew/opt/node@22/bin/node \
    /opt/homebrew/opt/node/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    [[ -x "$bin" ]] && printf '%s\n' "$bin"
  done
  for bin in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.fnm/aliases/default/bin/node \
    "$HOME"/.local/bin/node; do
    [[ -x "$bin" ]] && printf '%s\n' "$bin"
  done
}

knot_check_node() {
  local bin ver major best="" best_ver="" best_major="" seen=""
  while IFS= read -r bin; do
    [[ -n "$bin" ]] || continue
    case " $seen " in
      *" $bin "*) continue ;;
    esac
    seen="$seen $bin"
    [[ -x "$bin" ]] || continue
    ver="$(knot_node_version "$bin")"
    [[ -n "$ver" ]] || continue
    major="${ver%%.*}"
    [[ "$major" =~ ^[0-9]+$ ]] || continue
    if [[ -z "$best_major" ]] || (( major > best_major )); then
      best="$bin"
      best_ver="$ver"
      best_major="$major"
    fi
  done <<EOF
$(knot_node_candidates)
EOF
  if [[ -n "$best_major" ]] && (( best_major >= 22 )); then
    export KNOT_NODE_BIN="$best"
    knot_pf_row ok "Node" "v${best_ver} ${best}"
    return 0
  fi
  if [[ -n "$best_major" ]]; then
    knot_pf_row fail "Node" "v${best_ver} 太旧，需要 22+：${best}" \
      "$(knot_brew_bin) install node@22   # 或用 KNOT_NODE_BIN 指向已有的 22+"
  else
    knot_pf_row fail "Node" "PATH 与非交互默认位置里都找不到 node" \
      "$(knot_brew_bin) install node@22   # 或用 KNOT_NODE_BIN 指向已有的 22+"
  fi
  return 1
}

# ---- 数据库 ----
# 端口上坐着谁。pg_isready 只回答「这个端口是不是 Postgres」，被别的程序占着时
# 它只说 no response；等到 pg_ctl 才报 could not bind，报错点离原因很远。
knot_port_holder() {
  local port="$1"
  command -v lsof >/dev/null 2>&1 || return 0
  # pipefail 下 lsof 没匹配到也算失败，会让调用方的赋值在 set -e 里把脚本带走。
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}' || true
}

knot_check_pg_local() {
  local bin_dir="${KNOT_PG_BIN:-}" missing="" tool port="${KNOT_PGPORT:-5433}"
  if [[ -z "$bin_dir" ]]; then
    knot_pf_row fail "数据库" "KNOT_PG_BIN 是空的" \
      "在 site.env 里写 KNOT_PG_BIN=/opt/homebrew/opt/postgresql@16/bin"
    return 1
  fi
  for tool in initdb pg_ctl pg_isready psql createdb; do
    [[ -x "$bin_dir/$tool" ]] || missing="${missing}${missing:+ }${tool}"
  done
  if [[ -n "$missing" ]]; then
    knot_pf_row fail "数据库" "KNOT_PG_BIN=${bin_dir} 下缺 ${missing}" \
      "$(knot_brew_bin) install postgresql@16   # 或把 KNOT_PG_BIN 指到已有的 PostgreSQL 16"
    return 1
  fi
  # 首次部署时库还没起是正常的：建库与启动在第 3 步。这里只区分「工具齐」与「已就绪」。
  if "$bin_dir/pg_isready" -h 127.0.0.1 -p "$port" >/dev/null 2>&1; then
    # psql -h 传路径时指的是 socket 目录，不是数据目录。库已经在跑却找不到 socket，
    # 说明 socket 建在别处（旧脚本、手工起的库）：连得上，但要让人知道目录对不上。
    local sock="${KNOT_PG_SOCKET_DIR:-/tmp}"
    if [[ -S "$sock/.s.PGSQL.$port" ]]; then
      knot_pf_row ok "数据库" "本机 Postgres 已在 127.0.0.1:${port}（socket ${sock}）"
    else
      knot_pf_row warn "数据库" "本机 Postgres 已在 127.0.0.1:${port}，但 ${sock} 下没有 .s.PGSQL.${port}" \
        "socket 建在别处时，把 site.env 的 KNOT_PG_SOCKET_DIR 指过去（部署会先按实际目录连）"
    fi
  else
    local holder
    holder="$(knot_port_holder "$port")"
    if [[ -n "$holder" ]]; then
      # 端口被别的程序占着：pg_ctl 会 bind 失败，而那条报错看不出是端口问题。
      knot_pf_row fail "数据库" "端口 ${port} 已被 ${holder} 占用，本机 Postgres 起不来" \
        "改 site.env 的 KNOT_PGPORT（数据库端口，不是 KNOT_PORT）为没人用的端口"
      return 1
    fi
    knot_pf_row ok "数据库" "本机 Postgres ${bin_dir}（还没起，部署时会 initdb 并启动）"
  fi
}

# ---- 站点端口 ----
# 端口被别的程序占着时，Backend 起来就 EADDRINUSE，而那时 current 已经换过、迁移也跑完了，
# 部署只会回滚一次。这里在只读阶段就停下。占用者是本站点自己的 Backend（cwd 在本部署根下）
# 时算 ok：launchd 会在部署中途把它换掉，这是正常重装。
knot_check_site_port() {
  local port="${KNOT_PORT:-}" holder pid cwd root
  if [[ -z "$port" ]]; then
    knot_pf_row fail "端口" "KNOT_PORT 是空的，Backend 不知道听哪个端口" "在 site.env 里写 KNOT_PORT"
    return 1
  fi
  holder="$(knot_port_holder "$port")"
  if [[ -z "$holder" ]]; then
    knot_pf_row ok "端口" "127.0.0.1:${port} 空闲"
    return 0
  fi
  pid="$(printf '%s' "$holder" | sed -n 's/.*pid \([0-9]*\)).*/\1/p')"
  # 两个 pipefail 陷阱：lsof 没匹配到也是非零，赋值会被 set -e 带走；
  # 首次部署时部署根还不存在（它在门禁之后才 mkdir），直接 cd 会静默退出。
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
  root=""
  [[ -n "${KNOT_DEPLOY_ROOT:-}" && -d "$KNOT_DEPLOY_ROOT" ]] && root="$(cd "$KNOT_DEPLOY_ROOT" && pwd -P)"
  if [[ -n "$cwd" && -n "$root" && ( "$cwd" == "$root" || "$cwd" == "$root"/* ) ]]; then
    knot_pf_row ok "端口" "127.0.0.1:${port} 上是这个站点的 Backend（${holder}），部署时会被替换"
    return 0
  fi
  if [[ -z "$cwd" ]]; then
    # 看不出占用者是谁（别的用户的进程、权限不足）：只提示，不拿它拦住一次正常的升级。
    knot_pf_row warn "端口" "127.0.0.1:${port} 已被 ${holder} 占用，看不出它的工作目录" \
      "它若不属于本站点，部署会在起 Backend 时绑不上端口：先确认，再决定是否改 KNOT_PORT"
    return 0
  fi
  # 占用者是清楚的、又不是本站点的进程：它不会因为这次部署退出，Backend 一定绑不上。
  knot_pf_row fail "端口" "127.0.0.1:${port} 已被 ${holder} 占用，不是这个站点的进程" \
    "在 site.env 里把 KNOT_PORT 改成没人用的端口，或先停掉它（lsof -nP -iTCP:${port} -sTCP:LISTEN）"
  return 1
}

knot_probe_database_url() {
  local url="$1" probe out
  probe="${KNOT_APP_DIR:-}/backend/scripts/db-probe.mjs"
  if [[ ! -f "$probe" ]]; then
    knot_pf_row warn "数据库" "找不到 ${probe}，跳过连接检查"
    return 0
  fi
  if out="$("${KNOT_NODE_BIN:-node}" "$probe" "$url" 2>&1)"; then
    knot_pf_row ok "数据库" "${out#ok: }"
    return 0
  fi
  knot_pf_row fail "数据库" "${out#fail: }" \
    "external 模式不代装库：确认库已启动、网络可达、账号有权限，再核对 KNOT_DATABASE_URL。"
  return 1
}

knot_check_database() {
  case "${KNOT_DB_MODE:-local}" in
    external)
      if [[ -z "${KNOT_DATABASE_URL:-}" ]]; then
        knot_pf_row fail "数据库" "KNOT_DB_MODE=external，但没有 KNOT_DATABASE_URL" \
          "在 site.env 里写 KNOT_DATABASE_URL=postgres://<用户>:<口令>@<主机>:5432/<库名>"
        return 1
      fi
      knot_probe_database_url "$KNOT_DATABASE_URL"
      ;;
    *)
      knot_check_pg_local
      ;;
  esac
}
