/**
 * 版本日志（设置页展示，静态数据）
 * 用户友好版：只写功能视角，不含踩坑/根因等开发者内容
 * 结构：minor 为主条目，patch 嵌套在 patches 数组里（主界面只呈现 minor）
 * ⚠️ 公开文件：不得出现 gift/陈星/星尘 等隐私词
 */

export const APP_VERSION = 'V0.6.2 Antares'

/** 协议版本（用户协议/隐私政策最后更新日期，改协议时同步递增） */
export const AGREEMENT_VERSION = '2026-07-20'

/** 取全站最新更新条目（有 patch 取最新 patch，否则取最新 minor） */
export function getLatestUpdate() {
  const minor = CHANGELOG[0]
  if (minor.patches?.length) {
    const p = minor.patches[0]
    return { version: p.version, codename: minor.codename, date: p.date, items: p.items }
  }
  return { version: minor.version, codename: minor.codename, date: minor.date, items: minor.items }
}

export const CHANGELOG = [
  {
    version: 'V0.6.0', codename: 'Antares', date: '2026-07-20',
    items: [
      '设置页上线：个人资料编辑、账号安全、会员权益入口',
      '数据统计卡：记录你的提取数、转写字数与创作积累',
      '开源声明与版本日志入驻，每次更新一目了然',
      '登录页新增"忘记密码"，支持验证码重置',
    ],
    patches: [
      {
        version: 'V0.6.2', date: '2026-07-20',
        items: [
          '开发组在星空的各个角落埋了一批彩蛋，数量和位置概不透露',
          '据说有颗星星特别怕痒，连续戳它几下会有好事发生（只是据说）',
          '顺手做了一些界面细节优化，说不上哪里变了，但就是更顺眼了',
        ],
      },
      {
        version: 'V0.6.1', date: '2026-07-20',
        items: ['版本日志覆盖全部历史小版本，大版本内可展开查看'],
      },
    ],
  },
  {
    version: 'V0.5.0', codename: 'Deneb', date: '2026-07-20',
    items: [
      'AI 解读上线：针对视频字幕多轮追问，回复流式呈现',
      '对话记录自动保存，随时回来继续聊',
      '每轮对话展示 token 用量，消耗透明可见',
      '界面星光精修：星点氛围、全新分栏布局',
    ],
    patches: [
      {
        version: 'V0.5.1', date: '2026-07-20',
        items: ['用户协议与隐私政策内容更新'],
      },
    ],
  },
  {
    version: 'V0.4.0', codename: 'Altair', date: '2026-07-20',
    items: [
      '账号系统上线：邮箱注册登录，验证码与密码双通道',
      '云端版本正式发布，随时随地可用',
    ],
    patches: [
      {
        version: 'V0.4.5', date: '2026-07-20',
        items: ['修复协议页面的章节显示问题'],
      },
      {
        version: 'V0.4.4', date: '2026-07-20',
        items: ['小红书等平台提取更稳定、视频标题更准确', '界面信息展示优化'],
      },
      {
        version: 'V0.4.3', date: '2026-07-20',
        items: ['支持更多视频平台（小红书等）', '提取稳定性提升'],
      },
      {
        version: 'V0.4.2', date: '2026-07-20',
        items: ['修复账号数据保存问题'],
      },
      {
        version: 'V0.4.1', date: '2026-07-20',
        items: ['视频解析稳定性提升'],
      },
    ],
  },
  {
    version: 'V0.3.0', codename: 'Sirius', date: '2026-07-19',
    items: [
      '内容总结概要：一键生成视频核心要点',
      '数据自动清理：结果保留 1 小时，隐私更安心',
    ],
    patches: [
      {
        version: 'V0.3.1', date: '2026-07-19',
        items: ['Mac 使用体验优化'],
      },
    ],
  },
  {
    version: 'V0.2.0', codename: 'Vega', date: '2026-07-17',
    items: [
      'AI 智能整理：字幕自动语义分段，阅读更顺畅',
      'Markdown 结构化笔记导出，适配 Obsidian / Notion',
      '四步进度条，处理过程清晰可见',
    ],
    patches: [
      {
        version: 'V0.2.1', date: '2026-07-17',
        items: ['提取前成本预估：时长、字数、消耗一目了然', '界面动效优化'],
      },
    ],
  },
  {
    version: 'V0.1.0', codename: 'Polaris', date: '2026-07-15',
    items: [
      '首个可用版本：粘贴视频链接或上传文件，提取字幕',
      'SRT 字幕 + 整理文本双格式导出',
      '长视频自动分片识别',
    ],
    patches: [
      {
        version: 'V0.1.1', date: '2026-07-17',
        items: ['网站图标显示修复'],
      },
    ],
  },
  {
    version: 'V0.0.1', codename: 'Nebula', date: '2026-07-15',
    items: ['Stellaris 项目启动'],
    patches: [],
  },
]
