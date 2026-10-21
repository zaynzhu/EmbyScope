# 映览 macOS：安装、升级与备份

此包为个人自用的 macOS 原生版本，要求 macOS 14 或以上。文件名中的 `arm64` 用于 Apple Silicon Mac；不是 NAS 的 linux/amd64 镜像。不需要另装 Node、Docker 或数据库。

## 安装

1. 双击 `EmbyScope-版本-arm64.dmg`。
2. 将 `EmbyScope.app` 拖入同窗口的 `Applications` 文件夹。
3. 弹出磁盘映像，从“应用程序”打开映览。

同一时间只运行一份应用。已有实例会被激活；如仍在项目目录运行开发版，请先正常退出它。

此包使用本机临时签名，**没有 Developer ID 分发签名和 Apple 公证**。本机运行测试不等于其他 Mac 的 Gatekeeper 验证。若系统阻止启动，请先核对来源与 SHA-256，再由你决定是否使用系统提供的“仍要打开”；不要关闭系统保护或批量移除隔离属性。正式跨机器分发仍需可用的开发者分发身份和公证条件。

首次使用设置本地管理员密码；导入旧数据后沿用原管理员密码。密码不是 Emby 账号密码，连接账号分别加密保存。

## 配置与离线导入

配置目录：`~/Library/Application Support/EmbyScope/`。应用文件与数据分开保存。导入使用 SQLite 一致性备份，包含已提交的 WAL；不会改原网页配置，不会复制登录会话，并暂停自动更新。

导入产生的 `offline-preview` 文件强制离线：详情、海报及所有更新都不能访问远端。缺失海报显示占位，旧缓存继续标注时间。完成离线验证并决定允许远端读取后，退出应用，将此文件移出配置目录留存，再打开应用。自动更新仍保持关闭；手动更新、详情和缺失海报此后可能访问连接地址。

## 备份

建议升级前备份。内置命令支持应用运行时的一致性备份，目标必须是不存在的新目录；无需系统 Node。在 Mac 终端执行（路径可按实际安装位置调整）：

```sh
APP="/Applications/EmbyScope.app"
"$APP/Contents/Resources/runtime/node" \
  "$APP/Contents/Resources/service/desktop/backend/manage-data.js" backup \
  "$HOME/Library/Application Support/EmbyScope" \
  "$HOME/Documents/EmbyScope-backup-$(date +%Y%m%d-%H%M%S)"
```

备份含数据库和 `secret.key`。它们组合可以解密连接凭据，务必保护整个备份，不上传公开仓库。不复制实例锁，不依赖运行中的主数据库文件复制。

## 升级与恢复

升级：先备份，再正常退出映览（等待窗口消失），用新版本替换 `/Applications/EmbyScope.app`，最后重新打开。替换应用不会覆盖配置目录。

恢复：退出映览，将当前配置目录改名保留，再用下列命令从备份创建新的配置目录。目标已存在时命令会拒绝覆盖。

```sh
APP="/Applications/EmbyScope.app"
"$APP/Contents/Resources/runtime/node" \
  "$APP/Contents/Resources/service/desktop/backend/manage-data.js" import \
  "/你的备份目录" \
  "$HOME/Library/Application Support/EmbyScope"
```

恢复后进入离线预览、暂停自动更新并清除旧会话，先核对数据再决定是否允许联网。保留旧应用与对应备份才能可靠回退；不要假定未来版本的数据库可以直接由旧版本打开。

删除 `.app` 不删除数据。若要清理数据，请先做好完整备份。不要仅删除 `secret.key`，否则已有凭据将无法解密。
