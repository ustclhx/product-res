#!/usr/bin/env bash
set -euo pipefail
# 只增加本脚本拥有的规则，绝不 flush 或改变既有链策略。
for ipt in iptables ip6tables; do
  "$ipt" -w -S SAAS-INPUT >/dev/null 2>&1 || "$ipt" -w -N SAAS-INPUT
  "$ipt" -w -S DOCKER-USER >/dev/null 2>&1 || "$ipt" -w -N DOCKER-USER
  "$ipt" -w -S SAAS-DOCKER >/dev/null 2>&1 || "$ipt" -w -N SAAS-DOCKER
  add() { "$ipt" -w -C "$@" 2>/dev/null || "$ipt" -w -A "$@"; }
  add SAAS-INPUT -i lo -j ACCEPT
  add SAAS-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  add SAAS-INPUT -p tcp -m multiport --dports 22,80,443 -j ACCEPT
  if [[ "$ipt" == iptables ]]; then
    add SAAS-INPUT -p icmp -j ACCEPT
    add SAAS-INPUT -p udp --sport 67 --dport 68 -j ACCEPT
  else
    # 保留邻居发现、路径MTU和DHCPv6，不开放额外TCP业务端口。
    add SAAS-INPUT -p ipv6-icmp -j ACCEPT
    add SAAS-INPUT -p udp --sport 547 --dport 546 -j ACCEPT
  fi
  add SAAS-INPUT -j DROP
  add SAAS-DOCKER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  add SAAS-DOCKER -i docker+ -j RETURN
  add SAAS-DOCKER -i br+ -j RETURN
  # Docker DNAT 后需检查原始宿主端口；不能按容器端口放行或让直路由绕过。
  for port in 80 443; do
    add SAAS-DOCKER -p tcp -m conntrack --ctstate DNAT --ctorigdstport "$port" -j RETURN
  done
  add SAAS-DOCKER -j DROP
  # 插到原规则之前；已有跳转但顺序被改时拒绝，不擅自删除或重排。
  first() { "$ipt" -w -S "$1" | sed -n '/^-A /{p;q;}'; }
  for pair in 'INPUT SAAS-INPUT' 'DOCKER-USER SAAS-DOCKER' 'FORWARD DOCKER-USER'; do
    read -r chain target <<< "$pair"
    if "$ipt" -w -C "$chain" -j "$target" 2>/dev/null; then
      if [[ "$(first "$chain")" != "-A $chain -j $target" ]]; then
        # Docker可能在重启时前插自己的跳转；追加本脚本的首位保护，不删既有规则。
        "$ipt" -w -I "$chain" 1 -j "$target"
      fi
    else
      "$ipt" -w -I "$chain" 1 -j "$target"
    fi
  done
 done
