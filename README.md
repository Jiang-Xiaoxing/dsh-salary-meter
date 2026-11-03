# 打工养肥鱼

**DSH（DeepSeek Harness）社区插件**，在工作界面里放一只抱着白米饭的蓝毛鲸鱼娘，显示实时工资、当前时间、下班倒计时和模型饭钱估算。

![鲸鱼娘的三种姿态](assets/whale-girl-poses.png)

## 使用效果

| 深色 | 浅色 |
| --- | --- |
| ![深色挂件](docs/images/widget-dark.png) | ![浅色挂件](docs/images/widget-light.png) |

截图来自 DSH 0.2.1-rc.3 的实际客户端，演示时钟设为工作日 15:30，工资参数使用默认值，费用使用合成 token 记录演示。

## 功能

- 根据月薪、每月工作日、上下班时间和午休时长，持续累计当天工资。
- 显示当前时间、距下班倒计时和工作进度。午休暂停工资累计，倒计时继续。
- 显示未开工、上班中、午休中、已下班、休息日状态。
- 根据已识别模型的 token 使用记录估算当天“饭钱”。
- 模型工作时切换扒饭姿态，点击鲸鱼娘会露出偷吃被发现的表情。
- 跟随 DSH 的浅色和深色主题，可拖动挂件顶部调整位置。

## 安装

### DSH 桌面版

打开左侧“插件”，点击右上角“添加插件”，填写下方 GitHub 源并安装。

```text
github:Jiang-Xiaoxing/dsh-salary-meter#v0.1.2
```

其中 `github:` 表示从 GitHub 仓库获取插件，`Jiang-Xiaoxing/dsh-salary-meter` 是仓库名，`#v0.1.2` 固定安装本次发布版本。DSH 会下载插件代码及图片，并把插件加入当前运行环境。

安装完成后按 DSH 的提示刷新或重开界面，右侧会出现工资挂件。

### DSH Web

```sh
dsh plugin --profile web add github:Jiang-Xiaoxing/dsh-salary-meter#v0.1.2
```

`dsh` 是 Harness 命令，`plugin` 管理插件，`--profile web` 选择 Web 运行环境，`add` 安装该 GitHub 源。命令会更新这个 profile 的插件依赖和启用列表。界面生效方式按宿主提示处理。

## 设置和读数

点击挂件右上角的 `⋯` 打开工资参数设置，修改后点击“保存参数”。

| 读数 | 含义 |
| --- | --- |
| 今日打工入账 | 按有效上班时间累计的当天工资 |
| 今日肥鱼偷吃（估算） | 已统计的模型费用估算 |
| 碗里还剩 | 今日工资减去已统计模型费用后的估算余额 |
| 距下班 | 当前时刻至所设下班时间的倒计时 |

`≈` 表示费用经过估算。有未识别的模型调用时，费用显示已知部分的下限，余额显示上限，并标出“有遗漏”。

默认参数为月薪 5,000 元、每月工作 22 天、09:00 上班、18:00 下班、午休 1 小时，周末休息。午休从 12:00 起，并限制在班次范围内。Windows 首次启用时会尝试沿用原 SalaryMeter 的工资参数。

## 费用统计范围

费用使用 DSH 已提交的会话使用记录，支持 `deepseek-official` 和 `deepseek-account` 路由下的 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4-pro`。币种为人民币，价格核对日期为 2026-11-03，依据 DeepSeek 官方价格页。

统计覆盖插件启用期间的调用，以及当前已加载会话中当天的使用记录。记录按会话和事件序号去重，重开界面后继续使用已保存的统计。

工作日高峰和空闲时段按北京时间估算。当前统计范围未包含中国法定节假日价格调整、搜索与抓取费用、辅助模型调用，以及第三方模型和渠道价格。账单核对请使用服务商提供的记录。[DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

## 兼容性

| 环境 | 验证情况 |
| --- | --- |
| Windows，DSH 0.2.1-rc.3 | 2026-11-03 完成安装版运行时和真实客户端装载检查 |
| Windows，DSH 0.2.1-rc.5 | 2026-11-03 完成安装版运行时和真实客户端装载检查 |
| DSH 0.2.1-rc.4 | 等待验证 |
| 其他系统和版本 | 等待验证 |

已检查工资递增、倒计时递减、参数保存与落盘、浅色和深色画面、点击反馈、插件列表图标，以及 API 访问鉴权。费用数学和去重使用合成记录验证。

## 数据与插件管理

工资配置和当天费用统计保存在 `$DSH_HOME/data/dsh-salary-meter/`，未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。其中 `config.json` 保存工资参数，`ledger.json` 保存费用合计和去重位置。

客户端通过 DSH 自带的已鉴权接口读取数据，插件通过监听会话事件计算饭钱。停用或卸载在 DSH 的插件页操作。卸载后可自行清理上述数据目录。

## 图片与鸣谢

角色立绘根据社区“大肥鱼”鲸鱼娘形象，使用内置生图工具生成。三种姿态分别为抱碗装乖、埋头扒饭、偷吃被抓现行。

角色参考包括《吃白饭的大肥鱼》《蓝色大肥鱼表情包》《家里来了个吃白饭的大肥鱼》等二创，感谢社区创作者的形象和表达。插件介绍结构参考 dsh-pet 和 dsh-sidebar-qa。[吃白饭的大肥鱼](https://www.bilibili.com/video/BV1JFtZ6iEpt/)、[蓝色大肥鱼表情包](https://www.bilibili.com/video/BV1V88G6TEvg/)、[家里来了个吃白饭的大肥鱼](https://www.bilibili.com/video/BV1bXHW66Es5/)、[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)、[dsh-sidebar-qa](https://github.com/ChenRuoT/dsh-sidebar-qa)

代码使用 MIT 许可证。
