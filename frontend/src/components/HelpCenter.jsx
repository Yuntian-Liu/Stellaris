/**
 * 帮助中心 — 全站使用文档（左板块列表 + 右内容区）
 * 双壳复用：
 *   - HelpCenterModal：导航栏问号触发的弹窗（固定尺寸，不随内容伸缩；
 *     移动端单栏：板块列表 → 点入内容 → 返回列表）
 *   - HelpCenterView：设置页 SubviewShell 二级界面内嵌
 * 内容用 Markdown 编写（ReactMarkdown + GFM 渲染）：`高亮` / 引用块 / 表格全可用
 * 与术语轻提示（glossary.js）刻意两套：这里是完备文档，那边是一两句提醒
 */
import { useState, useEffect } from 'react'
import { Modal, Button } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  RocketOutlined, AppstoreOutlined, WalletOutlined,
  CrownOutlined, QuestionCircleOutlined, GithubOutlined,
  LeftOutlined,
} from '@ant-design/icons'

/* ── Markdown 渲染规则（Starlight 风格：行内码 = 主题色高亮胶囊）── */
const MD_COMPONENTS = {
  h3: ({ children }) => (
    <div style={{
      fontSize: 14, fontWeight: 600, color: 'var(--ink)',
      margin: '18px 0 8px',
    }}>{children}</div>
  ),
  p: ({ children }) => (
    <p style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9, margin: '0 0 8px' }}>{children}</p>
  ),
  strong: ({ children }) => <strong style={{ color: 'var(--ink)' }}>{children}</strong>,
  em: ({ children }) => <em style={{ color: 'var(--mute)' }}>{children}</em>,
  code: ({ children }) => (
    <code style={{
      background: 'var(--accent-light)', color: 'var(--accent)',
      borderRadius: 6, padding: '1px 7px',
      fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 500,
    }}>{children}</code>
  ),
  blockquote: ({ children }) => (
    <div style={{
      margin: '10px 0', padding: '8px 12px',
      borderLeft: '3px solid var(--accent)',
      background: 'var(--surface-2)', borderRadius: '0 8px 8px 0',
      fontSize: 12, color: 'var(--mute)', lineHeight: 1.7,
    }}>{children}</div>
  ),
  ul: ({ children }) => <ul style={{ margin: '0 0 8px', paddingLeft: 20 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 8px', paddingLeft: 20 }}>{children}</ol>,
  li: ({ children }) => (
    <li style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9 }}>{children}</li>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{children}</a>
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        border: '1px solid var(--hairline)', borderRadius: 8,
        fontSize: 12.5,
      }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{
      padding: '8px 10px', textAlign: 'left',
      background: 'var(--surface-2)', color: 'var(--mute)',
      fontWeight: 600, borderBottom: '1px solid var(--hairline)',
      whiteSpace: 'nowrap',
    }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '8px 10px', color: 'var(--body)',
      borderTop: '1px solid var(--hairline)',
    }}>{children}</td>
  ),
}

function Md({ children }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}

/* ── 板块定义（左侧列表顺序即展示顺序）── */
export const HELP_SECTIONS = [
  { key: 'start', icon: <RocketOutlined />, title: '快速上手' },
  { key: 'features', icon: <AppstoreOutlined />, title: '功能说明' },
  { key: 'billing', icon: <WalletOutlined />, title: '货币与计费' },
  { key: 'membership', icon: <CrownOutlined />, title: '会员权益' },
  { key: 'faq', icon: <QuestionCircleOutlined />, title: '常见问题' },
  { key: 'opensource', icon: <GithubOutlined />, title: '开源与版权' },
]

/* ── 板块内容（Markdown）── */

const MD_START = `
### 三步上手

1. **贴链接**——粘贴视频链接，或上传本地文件，点击「查看视频信息」
2. **看预估**——确认预计消耗的分钟数与量子波，确认后开始提取
3. **拿结果**——提取完成后下载字幕，或继续使用 AI 功能

### 支持的平台

| 平台 | 说明 |
|---|---|
| 哔哩哔哩 | 官方接口直连，长短链均可 |
| 小红书 | 视频笔记链接，长短链均可 |
| 本地上传 | MP4 / MKV / AVI 等常见格式 |
| 其他站点 | 可尝试，不保证成功（抖音、YouTube 暂不支持） |

### 不注册也能用

未登录每天可体验 \`10 分钟\` 基础转写，历史记录保存在你自己的浏览器里。注册后解锁每日 \`30 分钟\`、每周量子波赠送、\`30\` 引力波注册礼与云端历史记录。
`

const MD_FEATURES = `
### 智能分段

默认开启。语音转写的原始文字不分段落，智能分段将其整理为通顺的段落，便于阅读和复制。消耗量子波。

### 总结概要

一键生成视频的概述与要点，快速了解核心内容。消耗量子波。

### Markdown 结构化笔记

将视频内容整理为带大纲层级的笔记文件，可下载并导入 Notion、Obsidian 等笔记软件。消耗引力波。

### AI 解读

基于字幕内容与 AI 多轮对话：追问细节、解释概念、深入理解。数学公式原生渲染。消耗引力波。

### 导出与下载

结果页可下载 \`SRT\` 字幕、\`TXT\` 全文、\`MD\` 笔记，所有内容支持一键复制。复制和下载的内容会附带来源与版权信息（SRT 字幕文件除外），分享请注明来处。

### 文件柜（内测）

把提取结果转存云端，字幕 / 全文 / 笔记 / 概要 / AI 解读随时在线查看渲染版，不随历史记录清理而删除。在「设置 → 关于 → 星轨实验室」申请内测。

### 历史记录

提取结果按会员档位保留（免费 \`1 小时\`，会员最长 \`30 天\`），到期自动清理且不可恢复，重要内容请及时下载或转存文件柜。音频在转写完成后立即删除，服务器只保留文本。
`

const MD_BILLING = `
### 分钟

语音转写按视频时长计量。免费用户：每日 \`30\` 分钟 / 每周 \`120\` 分钟 / 每月 \`300\` 分钟，任一周期触顶即限。

重置时间：每日 04:00、每周一 04:00、每月 1 日 04:00（UTC+8）。

> 例：一个 16 分钟的视频，提取一次消耗 16 分钟额度。

### 量子波

驱动智能分段、总结概要。汇率：\`1 量子波 = 100 tokens\`，按实际用量结算。

量子波分两个钱包：**赠送钱包**每周一 04:00 重新发放，未用完不结转；**永久钱包**来自活动与奖励，不清零。消耗时先扣赠送，再扣永久。

> 例：16 分钟视频的字幕约 2600 tokens，智能分段（输入+输出）约 5200 tokens，按 100:1 结算为 52 量子波。

### 引力波

驱动 Markdown 结构化笔记、AI 解读。汇率：\`1 引力波 = 500 tokens\`。

注册即送 \`30\` 个，**永不过期**；注册礼、会员月赠、兑换、活动全部进入同一个永久钱包。

> 例：16 分钟视频生成 MD 笔记约消耗 5000 tokens，结算为 10 引力波；AI 解读每轮约 1500 tokens，结算为 3 引力波。

### 兑换与让利

- 量子波 → 引力波：\`25:1\`，每月限 \`5\` 次（会员更多）
- 引力波 → 量子波：\`1:20\`，随时可兑（往返有折损，想好再换）
- 所有扣费在成功后结算，**失败分文不取**
- 结算零头不到四成免单

> 例：某次分段实际用了 440 tokens，只按 4 量子波结算——40 的零头免单。

### 对账

每一笔消耗（分钟 / 量子波 / 引力波）都能在「设置 → 会员权益 → 消耗记录」里逐笔查到，含双钱包拆分明细。
`

const MD_MEMBERSHIP = `
### 档位一览

| 档位 | 价格 | 分钟 日/周/月 | 量子波周赠 | 引力波 | 历史保留 |
|---|---|---|---|---|---|
| 免费版 | — | 30 / 120 / 300 | 500 | 注册礼 30 | 1 小时 |
| Stargazer 观星者 | ¥8/月 | 40 / 160 / 480 | 650 | 50/月 | 24 小时 |
| Voyager 远航者 | ¥18/月 | 100 / 400 / 1200 | 1700 | 150/月 | 7 天 |
| Odyssey 奥德赛 | ¥68/月 | 300 / 1200 / 3600 | 5000 | 500/月 | 30 天 |

### 规则要点

- 会员周期自开通时刻起 \`30 天\`，支付由爱发电提供支持，付款后自动开通
- 会员期间的分钟与量子波按当前档位发放，不与免费档叠加
- **引力波是永久钱包**，不受档位变化影响
- 支付后未及时到账：提交工单并附上爱发电订单号，人工核验后开通
`

const MD_FAQ = `
**提取失败了怎么办？**

先重试一次；仍失败请提交工单（设置 → 关于 → 反馈与建议），建议附上任务 ID（历史记录里可复制）。任务失败不会扣费。

**为什么有的视频是语音转写，不是现成字幕？**

平台没有提供自带字幕时，会自动走云端语音识别，质量略低于官方字幕但完全可读。

**提示分钟数 / 量子波不足？**

对应额度已用完：等周期重置、用量子波兜底或兑换，也可以升级会员档位。

**历史记录不见了？**

历史按档位时限自动清理（免费 1 小时，会员最长 30 天），清理后不可恢复，重要内容请及时下载或转存文件柜。

**我的数据安全吗？**

音频转写后立即删除，只保留文本；诊断日志不含字幕内容。详见「设置 → 关于 → 隐私政策」。

**支付后会员没到账？**

提交工单并附上爱发电订单号，人工核验后开通。

> 以上都没覆盖到？提交工单，或到用户交流群（设置 → 关于 → 用户交流群）里问，开发者会跟进。
`

const MD_OPENSOURCE = `
### 开源协议

Stellaris 基于 **MIT 许可证**开源——任何人都可以自由查看、使用、修改和再分发源代码，只需保留原作者版权声明。

### 开发者

本项目由 **碳碳四键** 独立设计与开发。

### 参与共建

代码层面的技术讨论、问题报告、功能建议，欢迎到 GitHub 提交 Issue 或 PR：

[github.com/Yuntian-Liu/Stellaris](https://github.com/Yuntian-Liu/Stellaris)
`

const SECTION_MD = {
  start: MD_START,
  features: MD_FEATURES,
  billing: MD_BILLING,
  membership: MD_MEMBERSHIP,
  faq: MD_FAQ,
  opensource: MD_OPENSOURCE,
}

/* ── 左侧板块列表 ── */
function SectionNav({ active, onNavigate }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {HELP_SECTIONS.map((s) => {
        const on = s.key === active
        return (
          <div
            key={s.key}
            onClick={() => onNavigate(s.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 9,
              padding: '9px 12px', cursor: 'pointer',
              borderRadius: 'var(--r-input)',
              background: on ? 'var(--accent-light)' : 'transparent',
              color: on ? 'var(--accent)' : 'var(--body)',
              fontWeight: on ? 600 : 400,
              fontSize: 13, transition: 'background 0.15s',
            }}
          >
            <span style={{ fontSize: 14 }}>{s.icon}</span>
            {s.title}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 帮助中心内容体（双壳共用）
 * height：右内容区高度（弹窗传像素，二级界面传 calc 表达式）
 * singlePane：true 时单栏（active=null 显示列表，点入后显示内容 + 返回）
 */
export function HelpCenterContent({ active, onNavigate, height = 500, singlePane = false }) {
  const md = active ? SECTION_MD[active] : null

  if (singlePane) {
    return (
      <div style={{ height, overflowY: 'auto' }}>
        {md ? (
          <div style={{ padding: '4px 2px' }}>
            <Button
              type="text" size="small" icon={<LeftOutlined />}
              onClick={() => onNavigate(null)}
              style={{ marginBottom: 10, color: 'var(--mute)', padding: '0 4px' }}
            >
              返回列表
            </Button>
            <Md>{md}</Md>
          </div>
        ) : (
          <div style={{ padding: '4px 2px' }}>
            <SectionNav active={active} onNavigate={onNavigate} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 18, height }}>
      <div style={{ width: 148, flexShrink: 0 }}>
        <SectionNav active={active} onNavigate={onNavigate} />
      </div>
      <div style={{
        flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: 6,
        borderLeft: '1px solid var(--hairline)', paddingLeft: 18,
      }}>
        {md ? <Md>{md}</Md> : null}
      </div>
    </div>
  )
}

/** 移动端判定（双壳共用） */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia('(max-width: 768px)').matches
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

/**
 * 自含状态的帮助中心视图（板块选中态自持）
 * 弹窗壳与设置页二级界面共用；移动端单栏：列表 → 内容 → 返回
 */
export function HelpCenterView({ initialSection = 'start', height }) {
  const isMobile = useIsMobile()
  const [active, setActive] = useState(isMobile ? null : initialSection)
  return (
    <HelpCenterContent
      active={active}
      onNavigate={setActive}
      height={height ?? (isMobile ? '62vh' : 500)}
      singlePane={isMobile}
    />
  )
}

/** 弹窗壳（导航栏问号 / 事件总线触发）：固定尺寸，不随内容伸缩 */
export function HelpCenterModal({ open, initialSection, onClose }) {
  const isMobile = useIsMobile()
  // 每次打开自增 key 强制重挂载：导航 ? 回「快速上手」，计费链接直达「货币与计费」
  //（AntD Modal 关闭时不卸载内容，useState 初值不会自动重置——必须显式 remount）
  const [resetKey, setResetKey] = useState(0)
  useEffect(() => { if (open) setResetKey((k) => k + 1) }, [open])

  return (
    <Modal
      open={open} onCancel={onClose} footer={null} centered
      width={isMobile ? '94vw' : 760}
      title={<span className="font-display" style={{ fontSize: 16 }}>帮助中心</span>}
    >
      <HelpCenterView key={resetKey} initialSection={initialSection || 'start'} />
    </Modal>
  )
}
