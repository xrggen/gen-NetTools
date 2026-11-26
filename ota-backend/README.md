# gen-NetTools OTA 控制面 0.1.1

固定入口为 `https://ota.12306.gd.cn:23887`，支持 Ubuntu 上的 Docker Engine 与 Compose v2。23887 是本项目在用户确认后随机选出的 TCP 端口。Compose 项目名为 `gen-nettools-ota`，与同节点上的 ScreenShare 使用独立服务、端口和运行材料。

## Ubuntu 部署

1. 解压部署包，在新加坡节点使用本机命令 `ss -ltn 'sport = :23887'` 检查监听冲突，并检查已有容器的公开端口。为该服务开放入站 TCP 23887，按照节点现有防火墙和云安全组流程实施。双源访问由容器向公网发起。
2. 由运维将以下材料放入独立的宿主机目录，示例为 `/etc/gen-nettools-ota`。设置目录及文件权限，使容器内 `node` 用户（UID 1000）可读。Compose 将目录以只读方式挂载。部署包中的文件均是代码或文档。

| 相对路径 | 运行材料 |
| --- | --- |
| `tls/fullchain.pem` | 服务端叶证书及必要的中间证书链。叶证书 SAN 必须覆盖 `ota.12306.gd.cn`。 |
| `tls/server.pem` | 上述证书对应的服务端私钥。 |
| `publisher/verification.pem` | gen-NetTools 独立的 Ed25519 清单验签公钥。签名私钥放在独立发布侧。 |
| `client/access.txt` | 独立的控制面访问凭据，32 到 256 位无空白可打印 ASCII。通过受控渠道分发给获准使用 OTA 的客户端。 |
| `upstream/gitcode.txt` | 仅用于读取 gen-NetTools GitCode Release API 的凭据。 |
| `upstream/github.txt` | GitHub Release 只读凭据，可选；缺省时使用 GitHub 公共 API。 |

3. 在解压目录按以下顺序执行。默认最低客户端版本门槛为空；需要启用时显式设置 `NETTOOLS_OTA_MINIMUM_CLIENT_VERSION`。

```sh
export NETTOOLS_OTA_RUNTIME_DIR=/etc/gen-nettools-ota
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

镜像由部署机通过 Dockerfile 基于 Node 24 Bookworm 镜像构建，应用无 npm 依赖。容器健康检查验证内部 TCP 监听，外部验收使用 TLS 请求。公信证书可用系统 CA，私有 CA 场景由运维在验收端指定受信 CA 文件。证书更换并复核信任材料后，仅重启本 Compose 的 `control-plane`。

部署时若 GitCode 只读凭据尚待开通，可显式设置 `NETTOOLS_OTA_BOOTSTRAP_WITHOUT_UPSTREAM=1`，先完成容器、TLS 和访问控制验收。此时健康检查标记 `upstream: unconfigured`，授权后的更新检查和下载返回 `503 upstream_not_configured`。部署方挂载有效凭据后重新创建容器以开放更新查询。

```sh
curl --fail --show-error https://ota.12306.gd.cn:23887/healthz
```

### 新加坡节点复用 ScreenShare GitCode 授权

同节点部署可使用 `gen-nettools-ota-screenshare.service`。它在现有 ScreenShare 网关容器中启动 Release 读取进程，只允许读取 `u010019490/gen-NetTools` 的 Release 和三个 OTA 资产。进程监听 `127.0.0.1:48123`，由 systemd 管理的启动脚本通过进程间凭据访问。GitCode 授权留在网关运行环境中。控制面使用既有运行材料和公开端口。GitHub 私有仓库备用源仍需该仓库的只读授权。

将 `run-screenshare-ota.sh`、`server.mjs`、`screenshare-reader.mjs`、`screenshare-server.mjs` 和 systemd 单元部署到 `/opt/gen-nettools-ota/screenshare-reader-v1`。目录及文件由 root 管理。先运行脚本的 `--preview` 模式，在回环端口 48124 校验签名 Release。预览时维持正式端口的 Host 和 TLS SNI。停止预览后，停止原 Compose 的控制面容器并启用 systemd 单元。回退时先停止并禁用单元，再启动原容器。

上线后用 `systemctl is-enabled gen-nettools-ota-screenshare` 和 `systemctl is-active gen-nettools-ota-screenshare` 核对持久状态。使用现有 TLS 信任和客户端凭据分别检查旧版本和当前版本，并核对下载包 SHA-256。读取进程跟随现有 ScreenShare 网关的可用性，网关重启后 systemd 会重新建立读取通路。

## 控制面 API

| 请求 | 用途 |
| --- | --- |
| `GET /healthz` | 返回服务就绪状态，用于验证 DNS、TCP 及 HTTPS 建链。 |
| `GET /api/v3/client-update/check` | 查询当前版本可用更新。必传 `version`、`channel=stable\|beta`、`platform=win32` 和 `arch=x64`。Beta 订阅需 `developer_opt_in=1`。具备 GA 晋级能力的客户端传 `ota_policy=ga-promotion-v1`。 |
| `GET /api/v3/client-update/download/{provider}/release/{tag}/{asset}/{manifestSha256}` | 获取绑定到指定来源、版本、安装包名称及签名清单摘要的下载。Beta 安装包同样需要 `developer_opt_in=1`。 |

检查和下载携带 `Authorization: Bearer <访问凭据>`。Windows 客户端使用部署管理员预配置的授权。GitCode（`u010019490/gen-NetTools`）作为主源，GitHub（`xrggen/gen-NetTools`）作为备用源。只有 DNS、连接、超时、429 或上游 5xx 等可用性错误触发切换。鉴权、TLS 信任、签名、资产身份和数据错误会拦截更新。下载绑定单一来源与 tag。上游提供受信临时 CDN URL 时返回 302；上游直接返回文件时支持单一 Range，校验所返回的范围和长度。

更新可用时返回 `updateAvailable`、`requestedChannel`、`channel`、`provider`、`manifestBase64`、`signature`、`manifestSha256` 和 `downloadPath`，跨通道时另带 `transition`。认证和订阅异常分别为 401/403。固定下载绑定不符为 409。显式最低版本门槛返回 426，并附当前更新查询结果。

## Windows 客户端授权预配置

管理员在提权的受控部署流程中调用已安装的 `app\resources\app\dist\machine-helper.exe ota-provision`。通过标准输入提供现有部署凭据的原始 ASCII 字节（32 至 256 字节，无换行），发送后关闭输入流。退出码 `0` 表示已写入机器范围 DPAPI 加密的注册表值。新的配置在应用下次启动时生效。

应用优先使用管理员预配置的授权。对于既有安装，缺少预配置时沿用历史保存在本机的授权。软件更新页只提供通道设置和检查、下载、安装操作。

## 发布与签名合同

每个源的同一个 Release 包含这三项资产：

- `gen-NetTools-update.json`。UTF-8 签名清单，字段见 [清单样例](manifest.example.json)。
- `gen-NetTools-update.sig`。对清单原始字节的 Ed25519 签名，内容为 Base64 文本（解码后 64 字节）。
- `gen-NetTools-<版本>-win-x64-setup.exe`。与清单中的文件名、字节数和 SHA-256 一致的安装包。

正式版使用 `x.y.z`，测试版使用 `x.y.z-bN`，Release tag 固定为 `v<版本>`。同基础版本的正式版高于所有 Beta。GA 是 Beta 的一个签名阶段，清单包含 `releaseStage: "ga"`、同基础的 `promotionTarget`。正式清单通过 `promotesFrom` 明确批准可晋级的 GA 前身。支持 GA 的 beta 客户端优先按签名目标 tag 查找对应正式版；缺少批准时继续检查 Beta。明确切回 stable 使用最新正式版。保留测试订阅的正式版对更高的发行版本继续检查。

运维按 ScreenShare 的分发思路，独立向客户端分发固定 HTTPS 端点、受信证书链或 SPKI pin、控制面访问凭据和 OTA 验签公钥。客户端上线阶段需要重新校验原始清单签名、产品/版本身份、晋级授权，以及下载完成后的字节数与 SHA-256。重定向到 CDN 使用新请求并省略控制面访问凭据。TLS 证书、Ed25519 清单签名、Windows Authenticode 分别验证。

## 后续 OTA 计划

1. 在 Ubuntu 上验证 Compose 构建、健康检查和同节点端口隔离，再以独立材料验收真实双源检查和下载。
2. 接入 Windows 设置页的手动检查、后台检查、订阅开关、受信建链、下载进度和断点续传。
3. 验收实际更新前后的版本、UAC 提权、失败恢复、保留用户数据、Beta/GA 晋级，以及端点证书轮换流程。

本地自动测试可运行 `node --test ota.test.mjs screenshare-reader.test.mjs`。测试使用合成 Release 与临时内存签名。
