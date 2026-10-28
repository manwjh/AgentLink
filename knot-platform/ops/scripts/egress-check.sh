#!/usr/bin/env bash
# 判断一次请求实际从哪块网卡出去，用来证明「去入口的流量没被 VPN 隧道接管」。
#
# 用法：
#   ./ops/scripts/egress-check.sh --url https://<入口域名>/api/health
#   ./ops/scripts/egress-check.sh --url <地址> --interface en1 --interface utun4
#   ./ops/scripts/egress-check.sh --url <地址> --proxy
#
# 做法：请求前后各取一次网卡累计字节数，差值最大的那块就是出口。路由表回答
# 的是「会往哪发」，计数器回答的是「实际从哪出去了」；WARP 一类全局 TUN 会在
# 默认路由前面插更具体的条目，所以只有计数器不会被骗。
#
# 计数器的窗口里不只有这一次请求，同一时刻别的流量也一起算进去。找一台安静的
# 机器，或者把 --url 指到一个够大的响应上，让这一次的占比足够高。
#
# 只支持 macOS（netstat -ib 的列序）。出口是隧道类网卡时退出码为 3，方便在
# 部署脚本里直接当门禁用。
#
# 退出码：0 走物理网卡；1 请求失败或计数器没有变化；2 用法错误；3 走了 VPN 隧道。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/net-counters.sh
source "$SCRIPT_DIR/lib/net-counters.sh"

URL=""
TIMEOUT=60
USE_PROXY=0
IFACES=""

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "${1}" in
    --url)
      [[ $# -ge 2 ]] || { echo "--url 后面要跟地址。" >&2; exit 2; }
      URL="${2}"
      shift 2
      ;;
    --interface)
      [[ $# -ge 2 ]] || { echo "--interface 后面要跟网卡名。" >&2; exit 2; }
      IFACES="${IFACES} ${2} "
      shift 2
      ;;
    --timeout)
      [[ $# -ge 2 && "${2}" =~ ^[0-9]+$ ]] || { echo "--timeout 后面要跟秒数。" >&2; exit 2; }
      TIMEOUT="${2}"
      shift 2
      ;;
    --proxy)
      USE_PROXY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "不认识的参数：${1}（见 --help）" >&2
      exit 2
      ;;
  esac
done

[[ -n "${URL}" ]] || { echo "--url 是必填项，见 --help。" >&2; exit 2; }

# 只支持 macOS：Linux 的 netstat 没有 -ib，列也不一样。早点说清楚，
# 免得后面把「读不到计数器」误判成「没有流量」。
if ! knot_iface_counters | grep -q .; then
  echo "读不到网卡计数器：这个脚本只支持 macOS。" >&2
  exit 2
fi

BEFORE="$(mktemp "${TMPDIR:-/tmp}/knot-egress-before.XXXXXX")"
AFTER="$(mktemp "${TMPDIR:-/tmp}/knot-egress-after.XXXXXX")"
CARRIER="$(mktemp "${TMPDIR:-/tmp}/knot-egress-carrier.XXXXXX")"
trap 'rm -f "${BEFORE}" "${AFTER}" "${CARRIER}"' EXIT

PROXY_OPT=(--noproxy '*')
[[ "${USE_PROXY}" == 1 ]] && PROXY_OPT=()

knot_iface_counters >"${BEFORE}"

# curl 失败不中断：计数器已经采到了，先把「有没有发出去」这件事说清楚。
set +e
STATS="$(curl -s -o /dev/null -m "${TIMEOUT}" "${PROXY_OPT[@]}" \
  -w '%{http_code} %{time_total} %{size_download} %{speed_download}' "${URL}" 2>/dev/null)"
STATUS=$?
set -e

knot_iface_counters >"${AFTER}"

read -r HTTP_CODE TIME_TOTAL BYTES SPEED <<<"${STATS:-0 0 0 0}"

echo "地址：${URL}"
if [[ "${STATUS}" == 0 ]]; then
  echo "结果：HTTP ${HTTP_CODE}，${TIME_TOTAL} 秒，${BYTES} 字节"
else
  echo "结果：请求失败（curl 退出码 ${STATUS}）"
fi
echo

# 两个快照按网卡名对齐，只留差值为正的网卡：没动过的网卡不参与判断。
# 计数器归零或网卡重建会让差值为负，按 0 处理，不报成「倒着走」。
awk -v filters="${IFACES}" -v carrier="${CARRIER}" '
  function human(n) {
    if (n >= 1048576) return sprintf("%.1f MB", n / 1048576)
    if (n >= 1024) return sprintf("%.1f KB", n / 1024)
    return n " B"
  }
  NR == FNR { rx[$1] = $2; tx[$1] = $3; next }
  {
    name = $1
    if (filters != "" && index(" " filters, " " name " ") == 0) next
    d_rx = $2 - rx[name]
    d_tx = $3 - tx[name]
    if (d_rx < 0) d_rx = 0
    if (d_tx < 0) d_tx = 0
    if (d_rx + d_tx == 0) next
    n++
    order[n] = name
    got[n] = d_rx
    sent[n] = d_tx
    if (d_rx + d_tx > best) { best = d_rx + d_tx; top = name }
  }
  END {
    if (n == 0) exit
    printf "%-12s %12s %12s\n", "网卡", "收", "发"
    printf "%s\n", "------------------------------------"
    for (i = 1; i <= n; i++) {
      mark = (order[i] == top) ? "  <-" : ""
      printf "%-12s %12s %12s%s\n", order[i], human(got[i]), human(sent[i]), mark
    }
    print top > carrier
  }
' "${BEFORE}" "${AFTER}"

CARRIER_NAME="$(cat "${CARRIER}")"
echo

if [[ "${STATUS}" != 0 ]]; then
  echo "请求没成功，计数器里的变化来自重传或别的流量，不作判断。" >&2
  exit 1
fi
if [[ -z "${CARRIER_NAME}" ]]; then
  echo "计数器没有变化：请求没发出去，或者命中了不出网的缓存。" >&2
  exit 1
fi
if knot_iface_is_tunnel "${CARRIER_NAME}"; then
  echo "出口是 ${CARRIER_NAME}：流量进了 VPN 隧道，没有走物理网卡。" >&2
  echo "把目标地址排进分流（例如 warp-cli tunnel ip add），再跑一次。" >&2
  exit 3
fi
if [[ "${CARRIER_NAME}" == lo0 ]]; then
  echo "出口是 lo0：测的是本机回环，到不了外面。"
  exit 0
fi
echo "出口是 ${CARRIER_NAME}：走物理网卡，没有被隧道接管。"
