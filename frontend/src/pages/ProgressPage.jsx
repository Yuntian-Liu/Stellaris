/**
 * 页面 2：进度页 — Starlight 设计系统
 */
import { useEffect, useState } from 'react'
import { Progress, Typography, Button, Space, Steps, Spin } from 'antd'
import { ArrowLeftOutlined, CheckCircleFilled } from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

const STEPS = [
  { key: 'downloading', label: '下载视频' },
  { key: 'extracting_audio', label: '提取音频' },
  { key: 'fetching_subtitles', label: '抓取字幕' },
  { key: 'transcribing', label: '语音识别' },
  { key: 'exporting', label: '生成字幕' },
]

export default function ProgressPage({ taskId, onComplete, onBack }) {
  const [status, setStatus] = useState(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    const poll = async () => {
      try {
        const data = await api.getTask(taskId)
        if (cancelled) return
        setStatus(data.status)
        setProgress(data.progress)

        if (data.status === 'completed') { onComplete(data); return }
        if (data.status === 'failed') { setError(data.error || '任务失败'); return }

        setTimeout(poll, 2000)
      } catch (e) {
        if (!cancelled) setError(e.message || '查询失败')
      }
    }

    poll()
    return () => { cancelled = true }
  }, [taskId, onComplete])

  const currentStep = STEPS.findIndex(s => s.key === status)
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
          current={Math.max(0, currentStep)}
          status={stepStatus}
          items={STEPS.map(s => ({ title: s.label }))}
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
            <div style={{ textAlign: 'center' }}>
              <Spin size="small" />
              <Text className="font-caption" style={{ marginLeft: 10, fontSize: 13 }}>
                {STEPS[Math.max(0, currentStep)]?.label || '准备中...'}
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
