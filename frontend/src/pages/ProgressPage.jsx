/**
 * 页面 2：进度页 — Starlight 设计系统
 *
 * 4 步流程展示：下载视频 → 提取音频 → 语音识别 → 文本智能整理
 * 后端的 fetching_subtitles（可选）归并到"提取音频"，exporting 归并到"文本整理"末尾
 */
import { useEffect, useState } from 'react'
import { Progress, Typography, Button, Space, Steps, Spin } from 'antd'
import { ArrowLeftOutlined, CheckCircleFilled } from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

// 展示给用户的 4 个核心步骤
const DISPLAY_STEPS = [
  { title: '下载视频', description: '获取源文件' },
  { title: '提取音频', description: '分离音轨' },
  { title: '语音识别', description: 'ASR 转文字' },
  { title: '文本整理', description: 'LLM 智能分段' },
]

// 后端 status → (展示步骤索引, AntD Steps 的 current 索引)
// current 等于 DISPLAY_STEPS.length 表示全部完成
function mapStatusToCurrent(status) {
  switch (status) {
    case 'pending':              return 0   // 还没开始，停在第 0 步前
    case 'downloading':          return 0   // 进行第 1 步
    case 'extracting_audio':     return 1   // 进行第 2 步
    case 'fetching_subtitles':   return 1   // 可选 CC 字幕，归到第 2 步
    case 'transcribing':         return 2   // 进行第 3 步
    case 'text_processing':      return 3   // 进行第 4 步
    case 'exporting':            return 3   // 导出很快，归到第 4 步末尾
    case 'completed':            return 4   // 全部完成
    default:                     return 0
  }
}

// 当前正在进行中的步骤标题（用于 Spin 旁边的文字）
function getActiveLabel(status) {
  const map = {
    downloading: '正在下载视频...',
    extracting_audio: '正在提取音频...',
    fetching_subtitles: '正在抓取 CC 字幕...',
    transcribing: '正在语音识别...',
    text_processing: '正在整理文本...',
    exporting: '正在生成字幕...',
  }
  return map[status] || '准备中...'
}

export default function ProgressPage({ taskId, onComplete, onBack }) {
  const [status, setStatus] = useState(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    let timer = null

    const poll = async () => {
      try {
        const data = await api.getTask(taskId)
        if (cancelled) return
        setStatus(data.status)
        setProgress(data.progress)

        if (data.status === 'completed') { onComplete(data); return }
        if (data.status === 'failed') { setError(data.error || '任务失败'); return }

        timer = setTimeout(poll, 1500)
      } catch (e) {
        if (!cancelled) setError(e.message || '查询失败')
      }
    }

    poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [taskId, onComplete])

  const current = mapStatusToCurrent(status)
  const stepStatus = error ? 'error' : status === 'completed' ? 'finish' : 'process'

  return (
    <div style={{ paddingTop: 8 }}>
      {/* 标题区 */}
      <div style={{ marginBottom: 32 }}>
        <h2 className="font-display font-display-sm" style={{ marginBottom: 6 }}>
          正在处理...
        </h2>
        <Text className="font-caption" style={{ fontSize: 13 }}>
          Task ID:{' '}
          <code className="font-mono" style={{
            background: 'var(--surface-2)',
            padding: '2px 8px',
            borderRadius: 6,
            color: 'var(--body)',
          }}>{taskId}</code>
        </Text>
      </div>

      {/* 进度卡片 */}
      <div className="card card--elevated" style={{ padding: '28px' }}>

        {/* 步骤条 */}
        <Steps
          current={current}
          status={stepStatus}
          items={DISPLAY_STEPS.map(s => ({ title: s.title, description: s.description }))}
          style={{ marginBottom: 28 }}
        />

        {/* 进度条 + 状态文字 */}
        {!error && status !== 'completed' && (
          <>
            <Progress
              percent={progress}
              strokeColor={{ from: '#818cf8', to: 'var(--accent)' }}
              trailColor="var(--hairline)"
              size={['default', 6]}
              showInfo={false}
              style={{ marginBottom: 12 }}
            />
            <div style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
              <Spin size="small" />
              <Text className="font-caption" style={{ marginLeft: 10, fontSize: 13 }}>
                {getActiveLabel(status)}
              </Text>
            </div>
          </>
        )}

        {/* 完成状态 */}
        {status === 'completed' && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <CheckCircleFilled style={{ fontSize: 44, color: 'var(--success)', marginBottom: 12 }} />
            <h3 className="font-display font-display-xs" style={{ color: 'var(--ink)' }}>
              处理完成！
            </h3>
          </div>
        )}

        {/* 错误状态 */}
        {error && (
          <div style={{
            textAlign: 'center',
            padding: '20px',
            background: 'var(--error-bg)',
            borderRadius: 'var(--r-input)',
            color: 'var(--error)',
            fontSize: 14,
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* 操作按钮 */}
        <div style={{ marginTop: 24, textAlign: 'center' }}>
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              style={{ borderRadius: 'var(--r-btn)', height: 36 }}
            >
              返回
            </Button>
            {error && (
              <Button
                type="primary"
                onClick={() => window.location.reload()}
                style={{ height: 36 }}
              >
                重试
              </Button>
            )}
          </Space>
        </div>
      </div>
    </div>
  )
}
