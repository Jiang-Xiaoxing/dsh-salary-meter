# SalaryMeter · Windows 桌面工资挂件

蓝毛鲸鱼娘、滚轮余额、今日账目和跨天结算。完整功能与素材总览见 [项目首页](../README.md)。

> 当前桌面发布为 [desktop-v0.1.4](https://github.com/Jiang-Xiaoxing/dsh-salary-meter/releases/tag/desktop-v0.1.4)，安装包内部版本为 **0.2.3**。它与 DSH 插件 **v0.3.3** 是两个组件，不要混用版本号或安装方式。

## 下载与操作

- `SalaryMeter.exe`：免安装版。
- `SalaryMeter-Setup.exe`：安装版。
- 当前发布目标是 **Windows x64**，依赖 WebView2 Runtime。更新前先退出旧程序。

下载入口：[桌面版 Release](https://github.com/Jiang-Xiaoxing/dsh-salary-meter/releases/tag/desktop-v0.1.4)。

人物独立站在桌面上，脚下余额条显示今日工资减去模型费用估算。点击余额条或状态文字展开/收起账目；点人物有互动；拖动可移动并保存位置。点账目右上角 `⋯`、右键人物或托盘菜单打开设置。

设置支持工资作息、双休/单休/大小周、深色/浅白/暗金、80%–160% 人物大小；默认大小 130%。托盘支持设置、配色、置顶、鼠标穿透和退出，**当前代码没有开机自启菜单**。

### 界面预览

人物独立常驻，展开/收起的是今日账目。以下为仓库当前暗金样式截图：

| 收起账目 | 展开账目 |
| --- | --- |
| ![收起账目](docs/collapsed-gold.png) | ![展开账目](docs/expanded-gold.png) |

## 当前功能要点

- 工资按有效工时累计，午休暂停；提供开工/下班倒计时和工作状态。
- 金额逐位滚动，未变化的位数不动。扣费后红色冻结显示，3.6 秒无新扣费后补回期间工资；连续冻结最长 10 秒，不影响真实计算。
- 12 段透明 WebM 动画按上班、忙碌、午休、收工、休息、加班等状态切换，普通切换等片尾。视频失败时人物隐藏，账目照常，60 秒后重试。
- 彩蛋「伸手抓抓抓」会暂时把余额显示成 0，随后恢复，不扣款、不改账本。
- 设置展示每日工资、本月累计估算、近 1 小时 token/s，以及账目自检、价格来源和「重算今天的账」。
- 跨天账单展示昨日收入、费用和剩余；未收下的旧账单排队保留。点「收下」才算已读；点 × / Esc 本次暂不再弹，重启后仍会提醒。
- 结算记录损坏时先备份再重建。这里是工资与用量的估算工具，不是考勤系统或服务商账单。

## 与 DSH 联动

桌面 EXE 需要先下载或安装。DSH 插件不会自动下载安装它，只按以下顺序查找已有程序：

1. 环境变量 `SALARY_METER_EXE` 指定的完整路径。
2. 插件目录中的 `SalaryMeter.exe`。
3. `%LOCALAPPDATA%\SalaryMeter\SalaryMeter.exe`。
4. `E:\SalaryMeter\SalaryMeter.exe`。
5. `C:\Program Files\SalaryMeter\SalaryMeter.exe`。

安装路径不同或 EXE 名称不同时，可用第一种方式明确指定，再重启 DSH。插件已有同路径实例时不会再开一个。

插件启动的挂件通过宿主进程号跟随 DSH 退出；手动运行时也会尝试寻找 DS Bot 主进程，没有找到则独立运行。插件停用时只尝试关闭自己管理的实例，手动实例与宿主监视的行为不要混为一谈。

DSH 插件 v0.3.3 会写 `dsh-busy.json`，在状态变化时更新并每 5 秒续期。挂件读取有效心跳决定忙闲；超过 10 秒未更新或读不到时，回退到最近扣费和日志活动估算。

## 数据来源与存储

桌面版只读取本机现有的会话用量，不额外调用模型。

会话根目录依次选择：

1. 环境变量 `DSH_HOME`。
2. 若 `%USERPROFILE%\.ds-bot\data` 存在，使用 `%USERPROFILE%\.ds-bot`。
3. 否则使用 `%USERPROFILE%\.dsh`。

日志相对路径为 `sessions/<分组>/session-*/session.v4.jsonl.zstd`。程序解析压缩 JSONL 中的使用记录，按北京时间归日。价格优先合并启动时读到的插件价格缓存，否则使用内置价表；详细估算边界见 [首页](../README.md#模型饭钱怎么算)。

程序数据目录为 `%APPDATA%\com.local.salarymeter\`：

| 文件 | 用途 |
| --- | --- |
| `config.json` | 工资、作息、主题、大小和展开状态 |
| `position.json` | 窗口位置 |
| `settlements.json` | 结算账单、待确认队列及历史 |
| `dsh-busy.json` | 插件写入的任务忙闲心跳 |
| `startup.log`、`renderer.log` | 启动与动画运行排障 |

首次缺少桌面配置时会尝试迁移插件设置；之后两边不是实时双向同步。备份或搬迁时先退出程序，再复制数据目录。费用不一致时先核对目录、价格来源和工资配置，再使用重算功能。

工资实时显示使用系统本地时间，费用归日与跨天结算使用北京时间。非北京时间系统以及跨夜班次应谨慎核对，不要将当前计算当成完整排班支持。

## 从源码构建

在 Windows 上准备：

- Node.js（建议使用受支持的 LTS；若同时运行根目录插件，按其要求使用 Node.js ≥22）。
- Rust 稳定工具链；项目声明最低 Rust 1.77，实际依赖可能要求更新版本。
- Visual Studio C++ Build Tools 与 Windows SDK。
- WebView2 Runtime。

从仓库根目录执行：

```powershell
cd desktop
npm ci
npm run tauri:dev
```

打包：

```powershell
npm run tauri:build
```

产物在 `desktop/src-tauri/target/release/` 及其 `bundle/nsis/` 中。当前配置的安装器版本是 0.2.3，发布页下载名会简化为 `SalaryMeter-Setup.exe`；不要照搬旧 README 的 0.2.1 文件名。

### 源码目录

| 路径 | 内容 |
| --- | --- |
| `renderer/index.html`、`renderer/widget.js` | 桌宠主界面、金额与视频调度 |
| `renderer/odometer.mjs` | 逐位金额滚轮逻辑 |
| `renderer/pet-scenes.mjs`、`renderer/scene-scheduler.mjs` | 场景映射与片尾切换 |
| `renderer/assets/webm/` | 12 段桌宠视频 |
| `renderer/settings.html` | 设置与账目自检 |
| `renderer/settlement.*` | 结算窗口 |
| `src-tauri/src/lib.rs` | 窗口、托盘、配置、宿主跟随和命令 |
| `src-tauri/src/ledger.rs` | 会话日志扫描、费用和 token/s |
| `src-tauri/src/settlement.rs` | 跨天结算与账单保存 |
| `checks/` | 纯逻辑及界面回归脚本 |
| `网页版-salary-meter.html` | 早期网页版本参考，不是当前桌面入口 |

### 检查范围

根目录 `npm test` 检查插件计价核心；桌面 Rust 检查可在 `desktop/src-tauri` 中运行 `cargo test`。运行 `checks/` 的脚本前请阅读各自依赖：部分需要浏览器/Playwright 测试环境，并非装好 Tauri 就能直接全部运行。

已有 Release 记录报告了扣费冻结、视频层、场景调度、视频失败和结算模拟验证；真实零点长期运行、多显示器与非 150% 缩放尚有待验证项。文档更新不代表重新完成这些真机测试。

## 素材与许可

代码使用 [MIT](LICENSE)。十二段视频中十段来自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，保留 [第三方 MIT 许可](../LICENSE-dsh-pet)；「加班熬夜」「伸手抓抓抓」为本项目制作。素材总览见 [动画总览](../docs/images/desktop-actions.png)。桌面版不使用插件的图集作为视频失败回退。

Noto Sans CJK SC Regular / Medium 字体子集遵循 SIL OFL 1.1，保留 [字体说明](renderer/assets/fonts/README.md) 与 [OFL](renderer/assets/fonts/OFL.txt)。原字体在 `fonts-src/`，裁剪工具为 `tools/subset-fonts.py`，界面新增文字后需核对字体覆盖。其他形象来源及社区致谢见 [项目首页](../README.md#素材致谢与许可)。
