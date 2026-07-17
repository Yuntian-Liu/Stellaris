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
  message, Descriptions, Spin, Popconfirm,
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
} from '@ant-design/icons'
import api from '../hooks/api'

const { Text, Paragraph } = Typography

export default function ResultPage({ taskData, onBack, onNew }) {
  // MD 导出状态：从 taskData 初始值来，后续本地维护
  const [mdStatus, setMdStatus] = useState(taskData.md_status || 'idle')
  const [mdError, setMdError] = useState(taskData.md_error || null)
  const pollRef = useRef(null)

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [])

  const handleDownload = (format, label) => {
    const url = api.getDownloadUrl(taskData.task_id, format)
    const a = document.createElement('a')
    a.href = url
    a.download = `stellaris-${taskData.task_id}.${format}`
    a.click()
    message.success(`已下载 ${label}`)
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

  const sourceMap = {
    cc_subtitle: { text: 'CC 字幕', color: 'var(--success)', bg: 'var(--success-bg)' },
    asr_mimo: { text: 'Mimo ASR', color: 'var(--accent)', bg: 'var(--accent-light)' },
  }
  const source = sourceMap[taskData.subtitle_source] || {
    text: '未知', color: 'var(--mute)', bg: 'var(--surface-2)',
  }

  // 预览文本（后端返回的真实内容）
  const previewText = taskData.subtitle_txt || '（无文本内容）'

  return (
    <div>
      {/* ── 完成标识 ── */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'var(--success-bg)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
        }}>
          <CheckCircleFilled style={{ fontSize: 28, color: 'var(--success)' }} />
        </div>
        <h2 className="font-display font-display-sm" style={{ color: 'var(--ink)', marginTop: 0 }}>
          字幕提取完成
        </h2>
        <Text className="font-body" style={{ fontSize: 15, color: 'var(--mute)' }}>
          {taskData.video_title || '未知视频'}
        </Text>
      </div>

      {/* ── 结果卡片 ── */}
      <div className="card card--elevated" style={{ padding: '24px 24px 20px' }}>

        {/* 元信息 */}
        <Descriptions
          column={1}
          size="small"
          colon={false}
          style={{ marginBottom: 20 }}
          labelStyle={{ fontSize: 13, color: 'var(--mute)' }}
          contentStyle={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14 }}
        >
          <Descriptions.Item label="来源">
            <Tag style={{
              background: source.bg,
              color: source.color,
              border: 'none',
              borderRadius: '9999px',
              fontWeight: 500,
              fontSize: 12,
              padding: '2px 10px',
            }}>
              {source.text}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="任务 ID">
            <code className="font-mono" style={{
              background: 'var(--surface-2)',
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--body)',
            }}>{taskData.task_id}</code>
          </Descriptions.Item>
        </Descriptions>

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

        {/* 下载区 */}
        <div style={{
          paddingTop: 18,
          borderTop: '1px solid var(--hairline)',
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
          </Space>
        </div>
      </div>

      {/* 底部签名 */}
      <div style={{ textAlign: 'center', marginTop: 24 }}>
        <Text className="font-caption" style={{ color: 'var(--hairline-strong)' }}>
          Stellaris · Made with care
        </Text>
      </div>
    </div>
  )
}

/* ── 子组件：单行下载按钮 ── */
function DownloadRow({ icon, title, desc, primary = false, onClick }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, color: 'var(--ink)', fontSize: 14, marginBottom: 2 }}>
          {icon && <span style={{ marginRight: 8 }}>{icon}</span>}
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
