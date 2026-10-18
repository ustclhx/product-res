# 空白服务器初始化（D 2.5）

`deploy/selfhost/init-server.sh` 只初始化操作者明确选定的空白主机。审核并解压同一版本
release bundle，保留相邻的 `init-server.py`、`init-firewall.sh` 和 `.env.example`，执行：

```sh
sudo bash ./init-server.sh --dir /opt/product-res-selfhost
```

预检可先执行 `sudo bash ./init-server.sh --dir /opt/product-res-selfhost --check`。
入口不安装应用或 Dokploy，不创建真实 secret，不签发证书，不连接既有服务器。
完成后按部署/代理/备份 runbook 配置同版 bundle、镜像 digest、域名和 secret/TLS。
不要把此命令用于 `product-res-ecs` 或任何共用生产主机。

## 固定支持范围

| 项目 | 固定范围 |
| --- | --- |
| OS | Ubuntu 24.04 / noble；Debian 12 / bookworm；原生 systemd |
| 架构 | dpkg amd64 / arm64 |
| Docker Engine / CLI | 28.5.1（apt epoch `5:`） |
| Docker Compose plugin | 2.40.3 |
| containerd.io | 1.7.28，发行修订 `-2` |
| Buildx plugin | 0.29.1 |
| 基础工具 | Python 3、ss、dpkg、apt、systemctl；安装 ca-certificates/curl/iptables |
| 资源预检 | 至少 2 CPU、4 GiB 分配内存、`/var/lib` 至少 10 GiB 可用磁盘 |

Docker apt 包完整版本为 `<version>-1~<distro>.<release>~<codename>`；containerd 使用
`-2`。例如 Engine `5:28.5.1-1~debian.12~bookworm`。
四个 OS/架构组合的这些包在 2026-10-14 的 Docker 官方包目录均存在。
这是一组固定验收版本，升级时应审阅安全公告、调整固定版本并重新进行 VM 验证。
apt preferences 保持这五个精确版本，避免无人值守更新悄悄改变防火墙后端。
实际业务、备份峰值与磁盘增长预算需在部署前另行验证，预检不代表容量承诺。

安装使用 Docker 的 HTTPS 官方签名 apt 仓库，不执行在线 convenience installer。
依据：[Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、
[Debian 安装](https://docs.docker.com/engine/install/debian/)、
[官方包目录](https://download.docker.com/linux/debian/dists/bookworm/pool/stable/arm64/)。

## 预检、权限和重复执行

安装前拒绝：不支持的 OS/架构、非 root/systemd、资源不足、已安装容器运行时或
已有 Docker/containerd 数据、已有 Docker apt 源/daemon 配置、非空目标目录、
自定义 iptables/nftables 规则或非 ACCEPT 基础策略、启用的 UFW/firewalld/nftables。
不自动卸载、停止、迁移已有服务，不 flush 规则。

监听预检只允许 SSH 22、回环 DNS 53、DHCP 客户端 68/546，以及明确由
systemd-resolved 提供的基础 LLMNR 5355。LLMNR 的外部流量仍被最终防火墙阻止。
其他 TCP/UDP 监听，包括回环的业务服务、80/443，均拒绝。
SSH 会话和 sshd 配置必须使用 22，避免丢失使用自定义端口的连接。

`--dir` 必须位于 `/opt` 或 `/srv` 下；路径各层必须 root 所有且不可组/其他人写，
拒绝符号链接。部署目录、`secrets/` 和 `certs/` 是 root:0700，`.env` 是 root:0600，
仅复制同版 `.env.example` 的无真值内容，不 source dotenv。
安装状态保存在 `/var/lib/product-res-selfhost-init/state.json`（root:0600、父目录0700）。
Docker daemon/firewall/systemd/repository/pin 文件记录 SHA256；完成后的重复运行只验证，
不重新安装、不覆盖 `.env`、secret、证书或数据。修改 `.env` 属于正常后续配置，不参与
不可变文件 hash；若安装状态、托管配置、版本、权限或规则被修改则拒绝并要求人工检查。
初始化会使用独立的 `/run/product-res-selfhost-init.lock` 串行化。

若安装中断，状态保留 `complete:false`，重复运行拒绝；检查失败步骤后在这台空白测试
VM 重新建机，或由操作者审阅现状制定恢复步骤，不盲删状态重跑。首次 apt 安装短暂使用
`policy-rc.d` 阻止包安装自动启动 Docker，加载规则后才启用服务，finally 移除临时文件。
预先存在该文件的主机直接拒绝。安装错误只输出命令名称，不透传可能带代理凭据的工具
输出；需要详细诊断时由受授权操作者在受限主机内调查。

Compose file secret 的容器 UID 读取权限须按 `secrets.example` 设置。秘密单文件应0600且
属主匹配服务UID，或使用精确 ACL；宿主父目录保持root:0700。初始化不创建空密码文件。
证书 CA、PG SAN `DNS:postgres` 和各服务UID权限按既有 TLS runbook 配置，不能通过公开
宿主目录或跳过验证来解决。

## Docker 防火墙与开机启动

明确使用 Docker 28 的 iptables 后端：daemon `iptables=true`、`ip6tables=true`、
`userland-proxy=false`；支持发行版默认的 iptables-nft 接口，不直接写 nft 规则。
参考：[Docker iptables](https://docs.docker.com/engine/network/firewall-iptables/)。

IPv4 和 IPv6 均添加宿主 `INPUT → SAAS-INPUT`：回环、已建立/关联连接、TCP22/80/443、
必要 ICMP/ICMPv6 和 DHCP 客户端响应，其余 DROP。SSH 22 从加载规则之前到之后均保留；
不改变系统链 policy、不删除或清空任何既有规则。

Docker 转发使用 `FORWARD → DOCKER-USER → SAAS-DOCKER`，放行已建立连接和本机 Docker
桥接发起的出站流量，公网新连接只放行 DNAT 前的原始 TCP 宿主80/443；其余 DROP。
因此 `-p 5432:5432` 或 `-p 8080:80` 会被拒绝，容器端口80不能绕过宿主端口检查；
直接路由到容器地址也不能冒充 DNAT。不能只依赖 UFW INPUT 保护 Docker 发布端口。

`product-res-selfhost-firewall.service` 在 Docker 前运行；Docker unit 的 ExecStartPre/Post 每次
启动前后确保跳转首位和规则存在。Docker 重启前插跳转时只前插本脚本拥有的保护跳转，
不删除其规则；正常重复执行不追加重复规则。Docker 与防火墙服务均启用开机启动。
规则来源是 root:0700 的 `/usr/local/lib/product-res-selfhost/init-firewall.sh`，不保存或恢复整个
系统 ruleset，避免用旧快照覆盖 Docker 网络。额外防火墙管理器或手工规则修改不受支持，
托管规则变化会使重复初始化验证失败。

## 本地验证及未完成验收

安全边界用例：

```sh
python3 deploy/selfhost/test-init-server.py
bash -n deploy/selfhost/init-server.sh deploy/selfhost/init-firewall.sh
```

本轮只使用本机独占临时 Lima Debian12 arm64 VM `selfhost-init-d-deploy`，
containerd provisioning 禁用，2CPU/4GiB/24GiB。Lima 自带的 LIMADNS 规则首次触发拒绝，
没有安装动作；仅在该临时 VM 手动删除 Lima 自己的两个 nat 跳转及空链后进行安装，
不在初始化脚本加入任何自动清理例外。正式空白主机如存在规则也应保持拒绝。
安装输出 `Docker/Compose and firewall ready`，Engine28.5.1、Compose2.40.3实际可用，
重复运行输出 `existing initialization verified; configuration/data preserved`，目录权限
0700、`.env`0600。后续外部端口与 reboot 结果由本文件的证据补充段记录。

在完全符合 tasks 2.5 的临时 VM 外部端口、冲突和幂等证据齐全前保留2.5未勾选。
Ubuntu24.04/amd64 实机矩阵和公网 IPv6 实测未包含于本轮证据。6.3 还要求部署整个栈、
实际 reboot、backup恢复和B ownership签收，不能由Docker安装成功代勾。
真实服务器第7组仍保持BLOCKED，本轮没有连接任何真实服务器。

### 2026-10-14 VM 实测补充

Lima 使用默认用户网络外另加 `vzNAT`，宿主直接访问 VM 的 `192.168.64.2`，没有使用
Lima 的 localhost 端口转发作为外部证据。fixture 为官方
`python@sha256:efcdfa6a6b2fd2afb9c7dfa9a5b288a6f68338b5cfdebe6b637d986067d85757`，
一个 HTTP8000 服务同时发布宿主80/443/8080/5432：

```sh
sudo docker run -d --name init-port-fixture --restart=unless-stopped \
  -p 80:8000 -p 443:8000 -p 8080:8000 -p 5432:8000 \
  python@sha256:efcdfa6a6b2fd2afb9c7dfa9a5b288a6f68338b5cfdebe6b637d986067d85757 \
  python3 -m http.server 8000
```

宿主 Python `socket.create_connection((vm_ip, port), 2)` 实测22/80/443连接成功，
8080/5432/5355超时；`iptables -nvL SAAS-DOCKER` 的80/443放行规则各增加1包，
DROP增加4包，所以8080/5432阻止不是没有容器监听造成。测试HTTP只证明端口保护，
不冒充部署后的TLS验收。

同一fixture下 `systemctl restart docker` 后重新探测结果相同。因为fixture故意发布
8080/5432，重复初始化明确拒绝监听冲突；更改为仅发布80/443后重复初始化成功。
在`.env`追加非敏感注释、`secrets/init-test`写非敏感哨兵后，前后SHA256相同。

实际执行VM `systemctl reboot`，重连时`/proc/uptime`约19秒，Docker和防火墙服务均
`active`，仅80/443的fixture自动恢复，SSH22与80/443从宿主仍可达。随后运行初始化
verify再次成功。此证据只覆盖Docker和fixture，不覆盖应用/backup/B任务恢复。

另外，在这台隔离VM临时移动本初始化状态目录（退出trap立即恢复），针对新的空目录
预检实际拒绝已有托管配置，目标目录与新状态均未创建；临时在daemon配置增加空白后
verify拒绝`managed configuration changed`，恢复原文件后verify成功。这些测试没有
覆盖/清空业务数据，也没有用于任何真实服务器。

最终安全测试8项通过，bash语法和Python编译通过。这里只验证Debian12/arm64实际安装；
其它支持组合由固定包矩阵测试及官方包存在性核验覆盖，完整实机矩阵仍应由协调者安排。
本轮VM在证据收集后停止并删除，只清理本任务创建的资源。
