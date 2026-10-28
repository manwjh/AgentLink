#!/usr/bin/env bash
# 网卡累计字节数的快照，以及「这块网卡是不是 VPN 隧道」的判断。
#
# 「去入口的流量到底走物理网卡，还是被 WARP 一类的全局 TUN 接管了」不能只看
# 路由表。`route get` 回答的是「会往哪发」：分流规则写对之后它确实指向物理
# 网卡，但只要规则漏一条、或者有别的 TUN 在默认路由前面插了更具体的条目，
# 流量就已经进隧道了，而路由表那句话还是对的。
#
# 唯一不会被骗的是网卡自己的计数器：请求前后各取一次，字节数涨的那块网卡
# 就是真正的出口。代价是这个窗口里所有流量都算进去，所以要在安静的机器上取，
# 或者让被测请求足够大。
#
# macOS 的 `netstat -ib` 每块网卡有多行（链路行，外加每个地址一行），同一块
# 网卡的 Ibytes/Obytes 在各行完全重复，所以只取第一行，否则会翻倍。
#
# 用法：
#   source "$SCRIPT_DIR/lib/net-counters.sh"
#   knot_iface_counters > before
#   knot_iface_counters > after

# 打印「网卡 收字节 发字节」，一块网卡一行，取第一次出现的行。
#
# 不按固定列取 Ibytes/Obytes：地址列为空的链路行（utun 一类没有 MAC 的网卡）
# 会让后面的字段整体前移一格，按 $7/$10 取到的是 Opkts 和 Coll，看着也像个
# 大数字，不报错。每一行都以 Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll 收尾，
# 所以从行尾倒数取值，有没有地址列都一样。
knot_iface_counters() {
  netstat -ib 2>/dev/null |
    awk 'NR > 1 && NF >= 10 && !seen[$1]++ { print $1, $(NF - 4), $(NF - 1) }'
}

# 是不是隧道类网卡。命中说明流量被全局 TUN 接管，而不是从物理网卡出去。
# utun 是 macOS 的通用 TUN，WARP、各类商业 VPN 都用它；ipsec/ppp/tun/tap
# 是别的实现。lo0 不算：那是本机回环，说明测的是 127.0.0.1。
knot_iface_is_tunnel() {
  case "${1:-}" in
    utun* | ipsec* | tun[0-9]* | tap* | ppp*) return 0 ;;
    *) return 1 ;;
  esac
}
