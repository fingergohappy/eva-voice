# eva-voice

一个 Claude Code mod：在会话的每个阶段（开始、收到指令、跑命令、改文件、等待授权、完成、出错……）播放一句游戏语音：红警2 的 EVA、星际争霸的人族单位、魔兽3 的苦工、阿尔萨斯、吉安娜、鱼人等等。

A Claude Code mod that plays a game voice line at each stage of a session: Red Alert 2 EVA, StarCraft, Warcraft III and more.

## 安装

在 Claude Code 终端会话的输入框里：

```
/plugin install eva-voice --marketplace fingergohappy/eva-voice
```

先回答 `y` 添加这个 marketplace，再选安装范围（回车选用户范围）。

在 shell 里：

```sh
claude plugin install eva-voice --marketplace fingergohappy/eva-voice
```

桌面版里 `/plugin` 用不了：点输入框旁的 +，选 Plugins，用 `fingergohappy/eva-voice` 添加 marketplace，再添加插件。

装好后输入 `/voices`，在「在线语音包」里下载一个包（列表来自 [fingergohappy/eva-voice-packs](https://github.com/fingergohappy/eva-voice-packs)）。插件本身不带音频。

## 阶段

| key | 什么时候 |
|---|---|
| `session_start` | 会话开始 |
| `prompt_submit` | 你发出一条消息 |
| `turn_start` | 模型开始工作（默认关） |
| `tool_bash` / `tool_edit` | 跑 Bash / Edit·Write 改文件（8 秒冷却） |
| `agent_spawn` | 启动子 agent |
| `permission` | 工具调用等你授权 |
| `tool_error` | 工具调用失败 |
| `compact` | 压缩上下文 |
| `done` / `aborted` / `error` | 本轮结束：完成 / 被打断 / API 错误或拒绝 |
| `session_end` | 退出会话 |

子 agent 的回合和工具调用不出声，只有主循环会说话。

## 配置

- **输入框上方一栏**：🔊 / 🔇 点一下开关语音，后面是当前语音包，播放时显示 ▶ 正在播的那句，⚙ 打开配置面板。不想要这一栏，在面板里点「输入框上方: 显示」把它隐藏。
- **`/voices`** 打开面板：总开关、音量、语音包下拉框，每个阶段一行：`[x]` 开关、`▶` 试听、`换` 替换。点「换」后在那一行下面出现输入框，把音频文件拖进终端（或粘贴路径）回车即可。文件会复制到 `~/.config/eva-voice/custom/<stage>/`（Linux 上 mp3/m4a/aac/opus 用 ffmpeg 转成 wav），成为这个阶段的语音；「恢复默认」回到语音包自带的。
- **在线语音包**：面板下半部分列出可下载的包，下载 / 更新 / 使用 / 删除。下载时校验 sha256。
- `/voices on|off`，`/voices test <stage>`。
- 配置文件 `~/.config/eva-voice/config.json`，可以手改，每次发消息时重新读取。一个阶段的 `custom` 里有多个路径时随机挑一个。

## 语音包格式

一个包是一个目录：`<pack>/pack.json` 加 `<pack>/<stage>/*.wav`（多条时随机挑）。包放在 `~/.config/eva-voice/packs/<name>/`。自己做包也行，按这个结构放进去，面板的下拉框里就能选。

## 播放器

依次找 `pw-play`（PipeWire）、`paplay`、`afplay`（macOS）。

## 开发

```sh
claude --plugin-dir ~/code/mycode/eva-voice     # 带着这个 mod 启动
claude plugin validate .
claude plugin test .
```

或者把目录写进 Claude 设置 `env` 里的 `CLAUDE_CODE_PLUGIN_DIRS`，每个会话都会加载并热重载。
