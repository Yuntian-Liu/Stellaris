/**
 * 页面 3：结果页 — Starlight 设计系统
 *
 * 三大功能区：
 * 1. 预览区：直接展示整理后的 TXT 真实内容（不是文件路径）
 * 2. 下载区：SRT / 整理 TXT / 原文 MD（MD 为增值功能，按需触发）
 * 3. 操作区：返回 / 再来一个
 *
 * MD 导出状态机：idle → generating → ready（或 failed）
 */
import { useState, useEffect, useRef } from 'react'
import {
  Typography, Button, Space, Tag,
  message, Spin, Popconfirm, Modal,
} from 'antd'
import {
  DownloadOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  FileTextOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  CheckCircleFilled,
  LoadingOutlined,
  BulbOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'
import ReactMarkdown from 'react-markdown'
import ChatPanel from '../components/ChatPanel'
import Confetti from '../components/Confetti'

const { Text, Paragraph } = Typography

export default function ResultPage({ taskData, onBack, onNew, onChatToggle }) {
  // MD 导出状态：从 taskData 初始值来，后续本地维护
  const [mdStatus, setMdStatus] = useState(taskData.md_status || 'idle')
  const [mdError, setMdError] = useState(taskData.md_error || null)
  // 数据是否已被用户清理（清理后下载区禁用）
  const [cleaned, setCleaned] = useState(taskData.cleaned || false)
  // AI 解读分栏态（展开时通知 App 扩宽容器）
  const [chatOpen, setChatOpen] = useState(false)
  // 首次提星礼：本设备第一次完成提取时撒花
  const [firstStar, setFirstStar] = useState(false)
  const pollRef = useRef(null)

  useEffect(() => {
    if (!localStorage.getItem('stellaris_first_star')) {
      localStorage.setItem('stellaris_first_star', '1')
      setFirstStar(true)
      const t = setTimeout(() => setFirstStar(false), 4000)
      return () => clearTimeout(t)
    }
  }, [])

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [])

  const toggleChat = (open) => {
    setChatOpen(open)
    onChatToggle?.(open)
  }

  // 卸载时兜底复位容器宽度
  useEffect(() => () => onChatToggle?.(false), [onChatToggle])

  const handleDownload = (format, label) => {
    const url = api.getDownloadUrl(taskData.task_id, format)
    const a = document.createElement('a')
    a.href = url
    a.download = `stellaris-${taskData.task_id}.${format}`
    a.click()
    message.success(`已下载 ${label}`)
  }

  // 用户主动清理数据（带二次确认）
  const handleCleanup = () => {
    Modal.confirm({
      title: '清理提取数据？',
      content: '请确认已下载所有需要的文件。清理后 SRT / TXT 将无法重新下载。',
      okText: '确认清理',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        try {
          await api.cleanupTask(taskData.task_id)
          setCleaned(true)
          message.success('数据已清理')
        } catch (e) {
          message.error('清理失败：' + e.message)
        }
      },
    })
  }

  // 触发 MD 导出
  const handleExportMd = async () => {
    setMdStatus('generating')
    setMdError(null)
    try {
      await api.exportMarkdown(taskData.task_id)
      // 开始轮询 md_status
      _pollMdStatus()
    } catch (e) {
      setMdStatus('failed')
      setMdError(e.message)
      message.error('导出失败：' + e.message)
    }
  }

  // 轮询 MD 生成状态
  const _pollMdStatus = async () => {
    try {
      const data = await api.getTask(taskData.task_id)
      const s = data.md_status
      if (s === 'ready') {
        setMdStatus('ready')
        message.success('Markdown 已生成')
        return
      }
      if (s === 'failed') {
        setMdStatus('failed')
        setMdError(data.md_error || '生成失败')
        return
      }
      // generating，继续轮询
      pollRef.current = setTimeout(_pollMdStatus, 2000)
    } catch (e) {
      setMdStatus('failed')
      setMdError(e.message)
    }
  }

  // 来源平台（哔哩哔哩 / 小红书 / 本地上传 / 其他域名），后端 submit 时计算
  const platform = taskData.source_platform || '未知来源'

  // 预览文本（后端返回的真实内容）
  const previewText = taskData.subtitle_txt || '（无文本内容）'

  return (
    <div className="page-enter">
      {/* 首次提星礼（本设备第一次完成提取，撒花 4s） */}
      {firstStar && <Confetti />}
      {/* ── 完成标识（三部分竖排堆叠：标题 / 视频标题 / 保留提示）── */}
      <div style={{
        textAlign: 'center',
        marginBottom: 32,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}>
        <div className="check-pop" style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'var(--success-bg)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}>
          <CheckCircleFilled style={{ fontSize: 28, color: 'var(--success)' }} />
          {/* 完成时刻的小星星（彩蛋） */}
          <span className="star-dot" style={{ top: -12, right: -8, fontSize: 11, animationDelay: '0.4s' }}>✦</span>
          <span className="star-dot" style={{ bottom: -8, left: -10, fontSize: 8, animationDelay: '1.6s' }}>✦</span>
        </div>
        <h2 className="font-display font-display-sm" style={{ color: 'var(--ink)', margin: 0 }}>
          字幕提取完成
        </h2>
        <Text className="font-body" style={{ fontSize: 15, color: 'var(--mute)' }}>
          {taskData.video_title || '未知视频'}
        </Text>
        {/* 星空文案：完成时刻的一句 */}
        <div style={{
          fontSize: 12, color: 'var(--accent)', opacity: 0.85,
          fontFamily: "'Cormorant Garamond', serif", letterSpacing: '0.06em',
        }}>
          一颗新星已点亮 ✦
        </div>

        {/* 数据保留提示 / 已清理提示 */}
        <div style={{
          padding: '8px 14px',
          background: cleaned ? 'var(--surface-2)' : 'var(--accent-light)',
          borderRadius: 'var(--r-input)',
          display: 'inline-block',
          maxWidth: '100%',
        }}>
          <Text style={{
            fontSize: 12,
            color: cleaned ? 'var(--mute)' : 'var(--accent)',
            lineHeight: 1.6,
          }}>
            <InfoCircleOutlined style={{ marginRight: 6 }} />
            {cleaned
              ? '数据已清理，下载功能已关闭'
              : '为节省服务器资源，提取结果将暂存 1 小时，请在此期间完成下载。'}
          </Text>
        </div>
      </div>

      {/* ── 分栏行：结果卡 + AI 解读面板（面板与卡片顶底对齐）── */}
      <div style={chatOpen ? {
        display: 'flex', gap: 24, alignItems: 'stretch', flexWrap: 'wrap',
      } : undefined}>

      {/* ── 结果卡片 ── */}
      <div className="card card--elevated" style={{
        padding: '24px 24px 20px',
        ...(chatOpen ? { width: 760, flexShrink: 0, maxWidth: '100%' } : {}),
      }}>

        {/* 元信息（标签列 + 内容列，内容左边缘对齐） */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '64px 1fr',
          rowGap: 10,
          alignItems: 'center',
          marginBottom: 20,
        }}>
          <span style={{ fontSize: 13, color: 'var(--mute)' }}>来源</span>
          <Tag style={{
            background: 'var(--accent-light)',
            color: 'var(--accent)',
            border: 'none',
            borderRadius: '9999px',
            fontWeight: 500,
            fontSize: 12,
            padding: '2px 10px',
            margin: 0,
            justifySelf: 'start',
          }}>
            {platform}
          </Tag>
          <span style={{ fontSize: 13, color: 'var(--mute)' }}>任务 ID</span>
          <code className="font-mono" style={{
            background: 'var(--surface-2)',
            padding: '2px 8px',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--body)',
            justifySelf: 'start',
          }}>{taskData.task_id}</code>
        </div>

        {/* 内容概要（增值功能，可折叠） */}
        <SummarySection
          taskId={taskData.task_id}
          initialStatus={taskData.summary_status}
          initialContent={taskData.summary_content}
          initialError={taskData.summary_error}
          cleaned={cleaned}
        />

        {/* 预览区：展示真实文本内容 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 8,
            color: 'var(--mute)',
            fontSize: 13,
          }}>
            <FileTextOutlined style={{ marginRight: 6 }} />
            <span>字幕预览（整理后文本）</span>
          </div>
          <div style={{
            background: 'var(--surface-2)',
            borderRadius: 'var(--r-input)',
            padding: 18,
            maxHeight: 320,
            overflowY: 'auto',
            fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            fontSize: 14,
            lineHeight: 1.85,
            color: 'var(--ink)',
            whiteSpace: 'pre-wrap',
            border: '1px solid var(--hairline)',
          }}>
            {previewText}
          </div>
        </div>

        {/* AI 解读入口（分栏关闭时显示） */}
        {!chatOpen && (
          <div style={{ marginBottom: 20 }}>
            <button
              className="chat-entry"
              onClick={() => toggleChat(true)}
              disabled={cleaned}
            >
              <BulbOutlined style={{ fontSize: 16, color: 'var(--accent)' }} />
              <span style={{ flex: 1, textAlign: 'left' }}>
                <span style={{ display: 'block', fontWeight: 500, fontSize: 14, color: 'var(--ink)' }}>
                  AI 解读
                </span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--mute)', marginTop: 2 }}>
                  针对这个视频追问 AI，多轮对话深入理解
                </span>
              </span>
              <span style={{ color: 'var(--hairline-strong)', fontSize: 13 }}>→</span>
            </button>
          </div>
        )}

        {/* 下载区（清理后变灰禁用） */}
        <div style={{
          paddingTop: 18,
          borderTop: '1px solid var(--hairline)',
          opacity: cleaned ? 0.4 : 1,
          pointerEvents: cleaned ? 'none' : 'auto',
          transition: 'opacity 0.3s',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 14,
            color: 'var(--mute)',
            fontSize: 13,
          }}>
            <DownloadOutlined style={{ marginRight: 6 }} />
            <span>下载字幕</span>
          </div>

          <Space direction="vertical" size={14} style={{ width: '100%' }}>

            {/* SRT 主下载 */}
            <DownloadRow
              icon={<FileOutlined />}
              title="SRT 字幕文件"
              desc="含时间轴，可导入播放器 / 剪辑软件"
              primary
              onClick={() => handleDownload('srt', 'SRT')}
            />

            {/* TXT 下载（整理后） */}
            <DownloadRow
              icon={<FileTextOutlined />}
              title="TXT 纯文本"
              desc="已智能分段，方便阅读 / 复制给 AI"
              onClick={() => handleDownload('txt', 'TXT')}
            />

            {/* MD 导出（增值功能，状态机驱动） */}
            <MdExportRow
              status={mdStatus}
              error={mdError}
              onExport={handleExportMd}
              onDownload={() => handleDownload('md', 'Markdown')}
            />

          </Space>
        </div>

        {/* 操作区 */}
        <div style={{
          marginTop: 22,
          paddingTop: 18,
          borderTop: '1px solid var(--hairline)',
          textAlign: 'center',
        }}>
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              style={{ borderRadius: 'var(--r-btn)', height: 36 }}
            >
              返回首页
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={onNew}
              style={{ borderRadius: 'var(--r-btn)', height: 36 }}
            >
              再来一个
            </Button>
            {!cleaned && (
              <Button
                danger
                icon={<DeleteOutlined />}
                onClick={handleCleanup}
                style={{ borderRadius: 'var(--r-btn)', height: 36 }}
              >
                清理数据
              </Button>
            )}
          </Space>
        </div>
      </div>

      {/* ── 右栏：AI 解读面板 ──
          高度规则：外层 relative 占位（高度被 stretch = 左卡高度），
          面板卡片 absolute inset:0 填充——绝对定位不参与行高计算，
          所以行高永远由左卡决定；左变右跟随，右内容永不撑高页面 */}
      {chatOpen && (
        <div className="chat-panel-enter" style={{
          position: 'relative',
          flex: 1,
          minWidth: 420,
          minHeight: 480,
          alignSelf: 'stretch',
        }}>
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'var(--surface-1)',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--r-card)',
            padding: '16px 16px 14px',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <ChatPanel
              taskId={taskData.task_id}
              videoTitle={taskData.video_title || '未知视频'}
              subtitleText={taskData.subtitle_txt || ''}
              cleaned={cleaned}
              onClose={() => toggleChat(false)}
            />
          </div>
        </div>
      )}
      </div>

      {/* 底部签名（悬停浮现观星小诗，彩蛋） */}
      <FooterSignature />
    </div>
  )
}

/* ── 页脚签名 + 观星小诗（每次访问随机一句，悬停浮现）── */
const STAR_POEMS = [
  '今夜星空清澈，适合聆听',
  '每段声音，都值得被读懂',
  '星光落在字里行间',
  '宇宙很大，慢慢读',
  '把声音，点亮成文字',
]

function FooterSignature() {
  const [poem] = useState(() => STAR_POEMS[Math.floor(Math.random() * STAR_POEMS.length)])
  return (
    <div className="footer-sig" style={{ textAlign: 'center', marginTop: 24 }}>
      <div className="footer-poem" style={{
        fontSize: 12,
        color: 'var(--accent)',
        fontFamily: "'Cormorant Garamond', serif",
        letterSpacing: '0.08em',
        marginBottom: 4,
      }}>
        {poem}
      </div>
      <Text className="font-caption" style={{ color: 'var(--hairline-strong)' }}>
        Stellaris · Made with care
      </Text>
    </div>
  )
}

/* ── 子组件：单行下载按钮 ── */
function DownloadRow({ icon, title, desc, primary = false, onClick }) {
  return (
    <div className="dl-row" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 12px',
      margin: '0 -12px',
      borderRadius: 'var(--r-input)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14, marginBottom: 2 }}>
          {icon && <span style={{ marginRight: 8, color: 'var(--body)' }}>{icon}</span>}
          {title}
        </div>
        <div className="font-caption" style={{ fontSize: 12, color: 'var(--mute)' }}>
          {desc}
        </div>
      </div>
      <Button
        type={primary ? 'primary' : 'default'}
        icon={<DownloadOutlined />}
        onClick={onClick}
        style={{
          minWidth: 96,
          height: 38,
          borderRadius: 'var(--r-btn)',
          fontWeight: 500,
        }}
      >
        下载
      </Button>
    </div>
  )
}

/* ── 子组件：MD 导出行（状态机） ── */
function MdExportRow({ status, error, onExport, onDownload }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 14,
      background: 'var(--surface-2)',
      borderRadius: 'var(--r-input)',
      border: '1px solid var(--hairline)',
    }}>
      <div style={{ flex: 1, marginRight: 12 }}>
        <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14, marginBottom: 2 }}>
          <FileMarkdownOutlined style={{ marginRight: 8 }} />
          Markdown 结构化笔记
          <Tag style={{
            marginLeft: 8,
            background: 'var(--accent-light)',
            color: 'var(--accent)',
            border: 'none',
            borderRadius: '9999px',
            fontSize: 11,
            padding: '0 8px',
          }}>
            增值
          </Tag>
        </div>
        <div className="font-caption" style={{ fontSize: 12, color: 'var(--mute)' }}>
          {status === 'idle' && '用 LLM 转为结构化 MD，适合 Obsidian / Notion'}
          {status === 'generating' && '正在用 LLM 生成，请稍候...'}
          {status === 'ready' && '已生成，可下载 .md 文件'}
          {status === 'failed' && (error || '生成失败，可重试')}
        </div>
      </div>

      {status === 'idle' && (
        <Popconfirm
          title="生成 Markdown 笔记？"
          description="将调用 LLM 对原文进行结构化转写（增值功能）"
          okText="生成"
          cancelText="取消"
          onConfirm={onExport}
        >
          <Button
            icon={<FileMarkdownOutlined />}
            style={{ minWidth: 96, height: 38, borderRadius: 'var(--r-btn)' }}
          >
            生成
          </Button>
        </Popconfirm>
      )}

      {status === 'generating' && (
        <Button disabled style={{ minWidth: 96, height: 38, borderRadius: 'var(--r-btn)' }}>
          <LoadingOutlined spin style={{ marginRight: 6 }} />
          生成中
        </Button>
      )}

      {status === 'ready' && (
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={onDownload}
          style={{ minWidth: 96, height: 38, borderRadius: 'var(--r-btn)', fontWeight: 500 }}
        >
          下载
        </Button>
      )}

      {status === 'failed' && (
        <Button
          danger
          icon={<ReloadOutlined />}
          onClick={onExport}
          style={{ minWidth: 96, height: 38, borderRadius: 'var(--r-btn)' }}
        >
          重试
        </Button>
      )}
    </div>
  )
}

/* ── 子组件：内容概要区块（状态机 + 折叠展示） ── */
const SUMMARY_COLLAPSE_HEIGHT = 120   // 折叠态最大高度（px）

// Markdown 渲染样式映射（Starlight 风格，ChatPanel 复用）
export const MD_COMPONENTS = {
  h3: ({node, ...props}) => (
    <h3 style={{
      fontSize: 15, fontWeight: 600, color: 'var(--ink)',
      margin: '14px 0 6px', lineHeight: 1.5,
    }} {...props} />
  ),
  p: ({node, ...props}) => (
    <p style={{
      fontSize: 14, lineHeight: 1.8, color: 'var(--ink)',
      margin: '0 0 10px',
    }} {...props} />
  ),
  ul: ({node, ...props}) => (
    <ul style={{
      margin: '0 0 10px', paddingLeft: 20,
    }} {...props} />
  ),
  ol: ({node, ...props}) => (
    <ol style={{
      margin: '0 0 10px', paddingLeft: 20,
    }} {...props} />
  ),
  li: ({node, ...props}) => (
    <li style={{
      fontSize: 14, lineHeight: 1.8, color: 'var(--ink)',
      marginBottom: 4,
    }} {...props} />
  ),
  strong: ({node, ...props}) => (
    <strong style={{ fontWeight: 600, color: 'var(--ink)' }} {...props} />
  ),
  em: ({node, ...props}) => (
    <em style={{ color: 'var(--body)' }} {...props} />
  ),
  blockquote: ({node, ...props}) => (
    <blockquote style={{
      margin: '0 0 10px', padding: '4px 0 4px 12px',
      borderLeft: '3px solid var(--accent)',
      color: 'var(--body)', fontSize: 13,
    }} {...props} />
  ),
  code: ({node, ...props}) => (
    <code style={{
      background: 'var(--surface-1)', padding: '1px 6px',
      borderRadius: 4, fontSize: 13,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    }} {...props} />
  ),
}

function SummarySection({ taskId, initialStatus, initialContent, initialError, cleaned }) {
  const [status, setStatus] = useState(initialStatus || 'idle')
  const [content, setContent] = useState(initialContent || '')
  const [error, setError] = useState(initialError || null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const pollRef = useRef(null)
  const contentRef = useRef(null)

  // 组件卸载清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [])

  // 检测内容是否超出折叠高度（决定是否显示"展开"按钮）
  useEffect(() => {
    if (status === 'ready' && contentRef.current) {
      setOverflowing(contentRef.current.scrollHeight > SUMMARY_COLLAPSE_HEIGHT)
    }
  }, [status, content])

  const handleGenerate = async () => {
    setStatus('generating')
    setError(null)
    try {
      await api.summarize(taskId)
      _pollSummary()
    } catch (e) {
      setStatus('failed')
      setError(e.message)
      message.error('总结生成失败：' + e.message)
    }
  }

  const _pollSummary = async () => {
    try {
      const data = await api.getTask(taskId)
      const s = data.summary_status
      if (s === 'ready') {
        setStatus('ready')
        setContent(data.summary_content || '')
        message.success('内容概要已生成')
        return
      }
      if (s === 'failed') {
        setStatus('failed')
        setError(data.summary_error || '生成失败')
        return
      }
      pollRef.current = setTimeout(_pollSummary, 2000)
    } catch (e) {
      setStatus('failed')
      setError(e.message)
    }
  }

  // ── idle 状态：引导生成 ──
  if (status === 'idle') {
    return (
      <div style={{
        marginBottom: 20,
        padding: 16,
        background: 'var(--surface-2)',
        borderRadius: 'var(--r-input)',
        border: '1px solid var(--hairline)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14, marginBottom: 2 }}>
              <BulbOutlined style={{ marginRight: 8 }} />
              内容概要
              <Tag style={{
                marginLeft: 8,
                background: 'var(--accent-light)',
                color: 'var(--accent)',
                border: 'none',
                borderRadius: '9999px',
                fontSize: 11,
                padding: '0 8px',
              }}>
                增值
              </Tag>
            </div>
            <div className="font-caption" style={{ fontSize: 12, color: 'var(--mute)' }}>
              一键生成视频内容概要，快速了解核心观点
            </div>
          </div>
          <Popconfirm
            title="生成内容概要？"
            description="将调用 LLM 对字幕进行总结提炼（增值功能）"
            okText="生成"
            cancelText="取消"
            onConfirm={handleGenerate}
          >
            <Button
              icon={<BulbOutlined />}
              disabled={cleaned}
              style={{ minWidth: 84, height: 36, borderRadius: 'var(--r-btn)' }}
            >
              生成
            </Button>
          </Popconfirm>
        </div>
      </div>
    )
  }

  // ── generating 状态 ──
  if (status === 'generating') {
    return (
      <div style={{
        marginBottom: 20,
        padding: 18,
        background: 'var(--surface-2)',
        borderRadius: 'var(--r-input)',
        border: '1px solid var(--hairline)',
        textAlign: 'center',
      }}>
        <Spin size="small" />
        <Text className="font-caption" style={{ marginLeft: 10, fontSize: 13, color: 'var(--mute)' }}>
          正在用 LLM 提炼内容概要...
        </Text>
      </div>
    )
  }

  // ── failed 状态 ──
  if (status === 'failed') {
    return (
      <div style={{
        marginBottom: 20,
        padding: 16,
        background: 'var(--error-bg)',
        borderRadius: 'var(--r-input)',
        border: '1px solid var(--hairline)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <Text style={{ fontSize: 13, color: 'var(--error)', flex: 1 }}>
          概要生成失败：{error || '未知错误'}
        </Text>
        <Button
          danger
          size="small"
          icon={<ReloadOutlined />}
          onClick={handleGenerate}
          style={{ borderRadius: 'var(--r-btn)' }}
        >
          重试
        </Button>
      </div>
    )
  }

  // ── ready 状态：折叠展示总结内容 ──
  return (
    <div style={{
      marginBottom: 20,
      background: 'var(--surface-2)',
      borderRadius: 'var(--r-input)',
      border: '1px solid var(--hairline)',
      overflow: 'hidden',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid var(--hairline)',
      }}>
        <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}>
          <BulbOutlined style={{ marginRight: 8, color: 'var(--accent)' }} />
          内容概要
          <Tag style={{
            marginLeft: 8,
            background: 'var(--accent-light)',
            color: 'var(--accent)',
            border: 'none',
            borderRadius: '9999px',
            fontSize: 11,
            padding: '0 8px',
          }}>
            增值
          </Tag>
        </div>
        <Button
          type="text"
          size="small"
          onClick={() => setExpanded(!expanded)}
          style={{ fontSize: 12, color: 'var(--accent)', padding: '0 4px' }}
        >
          {expanded ? '收起' : '展开'}
        </Button>
      </div>

      {/* 内容区（折叠态 maxHeight 限制，展开态自由 + 内部滚动） */}
      <div
        ref={contentRef}
        style={{
          padding: '14px 16px',
          maxHeight: expanded ? 480 : SUMMARY_COLLAPSE_HEIGHT,
          overflowY: expanded ? 'auto' : 'hidden',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: 'var(--ink)',
          position: 'relative',
          // 折叠态底部渐变遮罩，暗示还有内容
          maskImage: expanded ? 'none' : 'linear-gradient(to bottom, black 80px, transparent 120px)',
          WebkitMaskImage: expanded ? 'none' : 'linear-gradient(to bottom, black 80px, transparent 120px)',
        }}
      >
        <ReactMarkdown components={MD_COMPONENTS}>{content}</ReactMarkdown>
      </div>

      {/* 折叠态下若溢出，底部显示"展开"提示 */}
      {!expanded && overflowing && (
        <div
          style={{
            padding: '6px 16px 10px',
            textAlign: 'center',
            cursor: 'pointer',
          }}
          onClick={() => setExpanded(true)}
        >
          <Text className="font-caption" style={{ fontSize: 12, color: 'var(--accent)' }}>
            展开查看完整概要 ↓
          </Text>
        </div>
      )}
    </div>
  )
}
