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
  CopyOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'
import { RETENTION_TEXT } from '../utils/tier'
import { COPY_FOOTER, FILE_FOOTER_MD } from '../utils/copyright'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import ChatPanel from '../components/ChatPanel'
import Confetti from '../components/Confetti'
import VaultStoreControl from '../components/VaultStoreControl'
import { useAuth } from '../contexts/AuthContext'

const { Text, Paragraph } = Typography

export default function ResultPage({ taskData, onBack, onNew, onChatToggle, onNeedAuth }) {
  const { user } = useAuth()
  // MD 导出状态：从 taskData 初始值来，后续本地维护
  const [mdStatus, setMdStatus] = useState(taskData.md_status || 'idle')
  const [mdError, setMdError] = useState(taskData.md_error || null)
  const [mdCost, setMdCost] = useState(taskData.md_cost ?? null)        // MD 实际扣引力波（生成完回填）
  const [mdTokens, setMdTokens] = useState(taskData.md_tokens ?? null)  // MD 实际 tokens（生成完回填）
  // 数据是否已被用户清理（清理后下载区禁用）
  const [cleaned, setCleaned] = useState(taskData.cleaned || false)
  // AI 解读分栏态（展开时通知 App 扩宽容器）
  const [chatOpen, setChatOpen] = useState(false)
  // 保留时长文案（按档位；未登录按 free 1 小时）
  const [retention, setRetention] = useState('1 小时')
  // 首次提星礼：本设备第一次完成提取时撒花
  const [firstStar, setFirstStar] = useState(false)
  const pollRef = useRef(null)

  // 进入结果页 = 提取计费已结算，刷新导航栏余额
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
  }, [])

  useEffect(() => {
    if (!user) return
    api.getBilling()
      .then(b => setRetention(RETENTION_TEXT[b.tier] || '1 小时'))
      .catch(() => {})
  }, [user])

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
      centered: true,
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

  // 增值功能登录拦截（未登录弹引导，不发请求）
  const requireAuth = (featureName, action) => {
    if (user) { action(); return }
    Modal.confirm({
      title: '登录后解锁',
      content: `${featureName}属于登录用户功能。注册即享完整额度，还有 30 引力波新人礼。`,
      okText: '去登录',
      cancelText: '再看看',
      centered: true,
      onOk: () => onNeedAuth?.(),
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
        if (data.md_cost) setMdCost(data.md_cost)
        if (data.md_tokens) setMdTokens(data.md_tokens)
        message.success('Markdown 已生成')
        window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
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

  // 转存到文件柜配置（kind ↔ 预填文件名后缀；未登录/未开通的权限闸在 VaultStoreControl 内）
  const videoTitle = taskData.video_title || '未知视频'
  const vaultFor = (kind, suffix) => ({
    taskId: taskData.task_id, kind, suffix, videoTitle, onNeedAuth,
  })

  return (
    <div className="page-enter" style={{ marginTop: -36 }}>
      {/* 首次提星礼（本设备第一次完成提取，撒花 4s） */}
      {firstStar && <Confetti />}
      {/* 顶部返回（历史回看/流程结束均有显性出口） */}
      <div style={{ marginBottom: 12 }}>
        <Button
          type="text" icon={<ArrowLeftOutlined />} onClick={onBack}
          style={{ color: 'var(--mute)', paddingLeft: 0 }}
        >
          返回
        </Button>
      </div>
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
              : retention === '永久'
                ? '提取结果为你永久保留，可随时回来下载与解读。'
                : `为节省服务器资源，提取结果将暂存 ${retention}，请在此期间完成下载。`}
          </Text>
        </div>
      </div>

      {/* ── 分栏行：结果卡 + AI 解读面板（面板与卡片顶底对齐）── */}
      <div style={chatOpen ? {
        display: 'flex', gap: 24, alignItems: 'stretch', flexWrap: 'wrap',
      } : undefined}>

      {/* ── 结果卡片 ── */}
      <div className="card card--elevated result-card-chat" style={{
        padding: '24px 24px 20px',
        ...(chatOpen ? { width: 760, flexShrink: 0, maxWidth: '100%' } : {}),
      }}>

        {/* 元信息（标签列 + 内容列，内容左边缘对齐） */}
        <div className="result-meta-grid" style={{
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
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {taskData.task_id}
              <CopyOutlined style={{ fontSize: 11, color: 'var(--mute)', cursor: 'pointer' }}
                onClick={() => { navigator.clipboard.writeText(taskData.task_id); message.success('已复制任务 ID') }} />
            </span>
          </code>
          {(taskData.actual_chars > 0 || taskData.charged_minutes > 0) && (
            <>
              <span style={{ fontSize: 13, color: 'var(--mute)' }}>本次消耗</span>
              <span style={{ fontSize: 13, color: 'var(--body)', justifySelf: 'start' }}>
                {taskData.actual_chars > 0 && `${taskData.actual_chars} 字 · ${taskData.actual_seg_tokens || 0} tokens`}
                {taskData.charged_minutes > 0 && (
                  /* 扣费部分独立 span：PC 用 ::before 补 " · " 同行显示；
                     移动端 .consume-charges 换块级到第二行（消耗/扣费分两行，不跨行） */
                  <span className="consume-charges">
                    扣 {taskData.charged_minutes} 分钟
                    {taskData.charged_quantum > 0 && ` + ${taskData.charged_quantum} 量子波`}
                  </span>
                )}
              </span>
            </>
          )}
        </div>

        {/* 内容概要（增值功能，可折叠） */}
        <SummarySection
          taskId={taskData.task_id}
          initialStatus={taskData.summary_status}
          initialContent={taskData.summary_content}
          initialError={taskData.summary_error}
          initialCost={taskData.summary_cost}
          initialTokens={taskData.summary_tokens}
          cleaned={cleaned}
          onNeedAuth={() => requireAuth('内容总结', () => {})}
          chars={previewText.length}
          vault={vaultFor('summary', '概要.md')}
        />

        {/* 预览区：展示真实文本内容 */}
        <div style={{ marginBottom: 20 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
            color: 'var(--mute)',
            fontSize: 13,
          }}>
            <span>
              <FileTextOutlined style={{ marginRight: 6 }} />
              字幕预览（整理后文本）
            </span>
            {/* 复制全文：粘到 Word/笔记软件自行编辑的场景 */}
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => {
                navigator.clipboard.writeText(previewText + COPY_FOOTER)
                message.success('已复制字幕全文')
              }}
              style={{ fontSize: 12, color: 'var(--mute)', padding: '0 4px' }}
            >
              复制
            </Button>
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
              onClick={() => requireAuth('AI 解读', () => toggleChat(true))}
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
              vault={vaultFor('srt', '字幕.srt')}
            />

            {/* TXT 下载（整理后） */}
            <DownloadRow
              icon={<FileTextOutlined />}
              title="TXT 纯文本"
              desc="已智能分段，方便阅读 / 复制给 AI"
              onClick={() => handleDownload('txt', 'TXT')}
              vault={vaultFor('txt', '全文.txt')}
            />

            {/* MD 导出（增值功能，状态机驱动） */}
            <MdExportRow
              status={mdStatus}
              error={mdError}
              onExport={() => requireAuth('Markdown 结构化笔记', handleExportMd)}
              onDownload={() => handleDownload('md', 'Markdown')}
              cost={mdCost}
              tokens={mdTokens}
              est={estCost(previewText.length, 500)}
              vault={vaultFor('md', '笔记.md')}
            />

          </Space>
        </div>

        {/* 操作区 */}
        <div className="result-actions" style={{
          marginTop: 22,
          paddingTop: 18,
          borderTop: '1px solid var(--hairline)',
          textAlign: 'center',
        }}>
          <Space wrap>
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
              onNeedAuth={onNeedAuth}
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
/** 前端预估扣费（仅展示；四成让利取整，与后端一致） */
function estCost(chars, unit) {
  const tokens = Math.ceil(chars / 1.5) * 2   // 输入+输出约 2 倍
  const base = Math.floor(tokens / unit)
  return base + (tokens % unit > unit * 0.4 ? 1 : 0)
}
function DownloadRow({ icon, title, desc, primary = false, onClick, vault }) {
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
      {vault ? (
        /* 主按钮仍是下载，下拉项「转存到文件柜」（权限闸在控件内） */
        <VaultStoreControl
          mode="download"
          {...vault}
          onDownload={onClick}
          buttonProps={primary
            ? { type: 'primary', icon: <DownloadOutlined /> }
            : { icon: <DownloadOutlined /> }}
        />
      ) : (
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
      )}
    </div>
  )
}

/* ── 子组件：MD 导出行（状态机） ── */
function MdExportRow({ status, error, onExport, onDownload, cost, tokens, est, vault }) {
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
          {status === 'ready' && `已生成${cost ? `，消耗 ${cost} 引力波` : ''}${tokens ? ` · ${tokens} tokens` : ''}，可下载 .md 文件`}
          {status === 'failed' && (error || '生成失败，可重试')}
        </div>
      </div>

      {status === 'idle' && (
        <Popconfirm
          title="生成 Markdown 笔记？"
          description={`预计消耗约 ${est} 引力波（按实际用量结算，零头不到四成免单）`}
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
        /* 下载按钮只出现在 ready（产物已生成），转存项天然不存在"未生成"态 */
        <VaultStoreControl
          mode="download"
          {...vault}
          onDownload={onDownload}
          buttonProps={{ type: 'primary', icon: <DownloadOutlined /> }}
        />
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

/**
 * LaTeX 分隔符归一化：将 LaTeX 标准 \(...\) / \[...\] 转为 remark-math
 * 识别的 $...$ / $$...$$。LLM 训练数据以 LaTeX 标准为主，经常输出前者。
 */
export function normalizeLatex(text) {
  if (!text) return text
  return text
    .replace(/\\\[/g, '$$')
    .replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$')
    .replace(/\\\)/g, '$')
}

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
  pre: ({node, ...props}) => (
    <pre style={{
      background: 'var(--surface-1)', padding: '10px 14px',
      borderRadius: 8, fontSize: 13, lineHeight: 1.7,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      overflowX: 'auto', margin: '0 0 10px',
      border: '1px solid var(--hairline)',
    }} {...props} />
  ),
  // 表格（remark-gfm 解析；窄面板下横滑，PC/移动端通吃，碳碳定稿）
  table: ({node, ...props}) => (
    <div style={{ overflowX: 'auto', margin: '0 0 10px' }}>
      <table style={{
        borderCollapse: 'collapse', fontSize: 13, minWidth: '50%',
      }} {...props} />
    </div>
  ),
  th: ({node, style, ...props}) => (
    // 样式必须合并：GFM 对齐标记（:---）会让 react-markdown 传入自己的
    // style(textAlign)，直接 {...props} 展开会整个覆盖自定义样式（V1.0.5 踩坑）
    <th {...props} style={{
      border: '1px solid #c7d2fe', padding: '6px 12px',
      background: 'var(--accent-light)', fontWeight: 600, color: 'var(--accent)',
      textAlign: 'left', whiteSpace: 'nowrap', ...style,
    }} />
  ),
  td: ({node, style, ...props}) => (
    <td {...props} style={{
      border: '1px solid #c7d2fe', padding: '6px 12px',
      color: 'var(--body)', lineHeight: 1.6, ...style,
    }} />
  ),
}

function SummarySection({ taskId, initialStatus, initialContent, initialError, initialCost, initialTokens, cleaned, onNeedAuth, chars, vault }) {
  const { user } = useAuth()
  const [status, setStatus] = useState(initialStatus || 'idle')
  const [content, setContent] = useState(initialContent || '')
  const [error, setError] = useState(initialError || null)
  const [cost, setCost] = useState(initialCost ?? null)
  const [tokens, setTokens] = useState(initialTokens ?? null)
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
    if (!user) { onNeedAuth?.(); return }   // 未登录：弹引导，不发请求
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
        if (data.summary_cost) setCost(data.summary_cost)
        if (data.summary_tokens) setTokens(data.summary_tokens)
        message.success('内容概要已生成')
        window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
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
            description={`预计消耗约 ${estCost(chars || 0, 100)} 量子波（按实际用量结算，零头不到四成免单）`}
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
          {cost > 0 && (
            <span className="font-mono summary-header-cost" style={{ marginLeft: 8, fontSize: 11, color: 'var(--mute)', fontWeight: 400 }}>
              消耗 {cost} 量子波{tokens ? ` · ${tokens} tokens` : ''}
            </span>
          )}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          {/* 复制 / 下载 .md：概要不只是看，也要能带走（前端 Blob 直下，不走后端） */}
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(content + COPY_FOOTER)
              message.success('已复制概要')
            }}
            style={{ fontSize: 12, color: 'var(--mute)', padding: '0 4px' }}
          >
            复制
          </Button>
          {/* 主按钮仍是下载（Blob 直下），下拉项「转存到文件柜」 */}
          <VaultStoreControl
            mode="download"
            {...vault}
            onDownload={() => {
              const blob = new Blob([content + FILE_FOOTER_MD], { type: 'text/markdown;charset=utf-8' })
              const a = document.createElement('a')
              a.href = URL.createObjectURL(blob)
              a.download = `stellaris-${taskId}-summary.md`
              a.click()
              URL.revokeObjectURL(a.href)
              message.success('已下载概要 .md')
            }}
            buttonProps={{ type: 'text', size: 'small', icon: <DownloadOutlined /> }}
          />
          <Button
            type="text"
            size="small"
            onClick={() => setExpanded(!expanded)}
            style={{ fontSize: 12, color: 'var(--accent)', padding: '0 4px' }}
          >
            {expanded ? '收起' : '展开'}
          </Button>
        </span>
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
        <ReactMarkdown components={MD_COMPONENTS} remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>{normalizeLatex(content)}</ReactMarkdown>
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
