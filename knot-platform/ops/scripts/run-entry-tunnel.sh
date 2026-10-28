#!/usr/bin/env bash
# 实例主机主动连出，把入口的回源端口转到本机 Knot Backend。
#
# 账号、私钥和端口来自两处，后者覆盖前者：
#   sites/<站点>/site.env       站点自己描述的部分（本机端口等）
#   sites/<站点>/tunnel.env     中枢开通时写入的托管件（由管理界面维护）
#
# 托管件里的键：
#   KNOT_TUNNEL=1
#   KNOT_TUNNEL_SSH=<隧道账号>@<入口主机>
#   KNOT_TUNNEL_KEY=tunnel_ed25519      相对站点目录；绝对路径也认，手工配置常用 $HOME/.ssh/...
#   KNOT_TUNNEL_REMOTE_PORT=<中枢分配的回环端口>
#   KNOT_TUNNEL_LOCAL_PORT=<本机 Backend 端口>
#
# 入口侧的 conf、证书与 sshd 规则都由中枢维护，这个脚本只负责连出去。
# 入口主机上给这个账号的 sshd 规则见 xknot.si 仓库的 server/provision.mjs。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/site-config.sh
source "$SCRIPT_DIR/lib/site-config.sh"

TUNNEL_ENV="${KNOT_SITE_DIR:-}/tunnel.env"
if [[ -n "${KNOT_SITE_DIR:-}" && -f "$TUNNEL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$TUNNEL_ENV"
fi

if ! knot_enabled KNOT_TUNNEL; then
  echo "KNOT_TUNNEL 未开启，隧道不启动"
  exit 0
fi
knot_require KNOT_TUNNEL_SSH "在 sites/$KNOT_SITE/tunnel.env 里写 KNOT_TUNNEL_SSH=<账号>@<入口主机>。"
knot_require KNOT_TUNNEL_REMOTE_PORT "在 sites/$KNOT_SITE/tunnel.env 里写 KNOT_TUNNEL_REMOTE_PORT。"

KEY="$(knot_tunnel_key_path)"
# 密钥不在就说清楚是哪一份配置把它指到这里，不要留给 ssh 一句
# "Identity file ... not accessible" —— 那行看不出是谁写的路径。
if [[ ! -f "$KEY" ]]; then
  echo "隧道私钥不存在：$KEY" >&2
  echo "  来自 sites/$KNOT_SITE 的 KNOT_TUNNEL_KEY=${KNOT_TUNNEL_KEY:-（空，按站点目录取 tunnel_ed25519）}" >&2
  echo "  密钥丢了不要重用旧名：换一个文件名让实例重新生成并提交，中枢会从建账号那一步重跑。" >&2
  exit 1
fi
# ConnectTimeout 是给系统级 VPN 留的：WARP 一类全局 TUN 接管到入口主机的
# TCP 时，握手能成但密钥交换的大包过不去，没有超时这个 ssh 会一直挂着，
# launchd 以为它还活着，/api 就一直是 502 而不是快速失败后重连。
#
# 软限必须抬：一条转发连接一个 fd，launchd 给的 256 在两百个读者上下就满了，
# ssh 会 "socket: Too many open files" 并把新连接 reset 掉。
# shellcheck source=lib/fd-limit.sh
source "$SCRIPT_DIR/lib/fd-limit.sh"
knot_raise_fd_limit
exec /usr/bin/ssh -N \
  -i "$KEY" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o ConnectTimeout=15 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  -R "127.0.0.1:$KNOT_TUNNEL_REMOTE_PORT:127.0.0.1:$KNOT_TUNNEL_LOCAL_PORT" \
  "$KNOT_TUNNEL_SSH"
