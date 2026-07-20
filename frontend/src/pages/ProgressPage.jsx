/**
 * 页面 2：进度页 — Starlight 设计系统
 *
 * 4 步流程：下载视频 → 提取音频 → 语音识别 → 文本整理
 *
 * 动态化设计（替代原 AntD Steps 静态步骤条）：
 *   - 自绘步骤轨：步骤完成时，连接线以 0.6s 动画填充到下一节点
 *   - 当前节点：呼吸脉冲光环 + 节点内转动指示
 *   - 完成节点：打勾 scale 弹入
 *   - 总进度条：宽度平滑过渡（与 1.5s 轮询节奏对齐）+ 流光缓冲动画
 */
import { useEffect, useState } from 'react'
import { Typography, Button, Space } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, LoadingOutlined } from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

// 展示给用户的 4 个核心步骤
const DISPLAY_STEPS = [
  { title: '下载视频', description: '获取源文件' },
  { title: '提取音频', description: '分离音轨' },
  { title: '语音识别', description: 'ASR 转文字' },
  { title: '文本整理', description: 'LLM 智能分段' },
]

// 后端 status → 展示步骤索引（等于 DISPLAY_STEPS.length 表示全部完成）
function mapStatusToCurrent(status) {
  switch (status) {
    case 'pending':              return 0
    case 'downloading':          return 0
    case 'extracting_audio':     return 1
    case 'fetching_subtitles':   return 1
    case 'transcribing':         return 2
    case 'text_processing':      return 3
    case 'exporting':            return 3
    case 'completed':            return 4
    default:                     return 0
  }
}

// 当前进行中的步骤文字
function getActiveLabel(status) {
  const map = {
    downloading: '正在下载视频',
    extracting_audio: '正在提取音频',
    fetching_subtitles: '正在抓取 CC 字幕',
    transcribing: '正在语音识别',
    text_processing: '正在整理文本',
    exporting: '正在生成字幕文件',
  }
  return map[status] || '准备中'
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

        if (data.status === 'completed') {
          // 稍作停留，让最后一段连接线动画播完再跳转
          timer = setTimeout(() => { if (!cancelled) onComplete(data) }, 900)
          return
        }
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

  return (
    <div className="page-enter" style={{ paddingTop: 8 }}>
      {/* 标题区 */}
      <div style={{ marginBottom: 32 }}>
        <h2 className="font-display font-display-sm" style={{ marginBottom: 6 }}>
          {error ? '处理遇到问题' : '正在处理'}
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
      <div className="card card--elevated" style={{ padding: '36px 28px 28px' }}>

        {/* ── 动态步骤轨 ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 36 }}>
          {DISPLAY_STEPS.map((step, i) => {
            const done = i < current
            const active = i === current && !error
            return (
              <div key={step.title} style={{ display: 'flex', alignItems: 'center', flex: i < DISPLAY_STEPS.length - 1 ? 1 : 'none' }}>
                {/* 节点 */}
                <StepNode
                  index={i}
                  done={done}
                  active={active}
                  error={error && i === current}
                  title={step.title}
                  description={step.description}
                />
                {/* 连接线（最后一个节点后不画） */}
                {i < DISPLAY_STEPS.length - 1 && (
                  <div style={{
                    flex: 1,
                    height: 2,
                    margin: '0 10px',
                    marginTop: -34,          // 与节点圆心对齐（节点下方还有文字）
                    background: 'var(--hairline)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}>
                    {/* 填充层：上一步完成时 0.6s 动画填满 */}
                    <div style={{
                      height: '100%',
                      width: done ? '100%' : '0%',
                      background: 'var(--accent)',
                      borderRadius: 2,
                      transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                    }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── 总进度条（平滑过渡 + 流光缓冲）── */}
        {!error && (
          <>
            <div style={{
              height: 6,
              background: 'var(--hairline)',
              borderRadius: 9999,
              overflow: 'hidden',
              marginBottom: 16,
              position: 'relative',
            }}>
              <div style={{
                height: '100%',
                width: `${progress}%`,
                background: 'linear-gradient(90deg, #818cf8, var(--accent))',
                borderRadius: 9999,
                // 与 1.5s 轮询节奏对齐的线性插值，消除跳变感
                transition: 'width 1.4s linear',
                position: 'relative',
                overflow: 'hidden',
              }}>
                {/* 流光层：持续扫过，营造缓冲感 */}
                <div className="progress-shimmer" />
                {/* 彗星头：进度前缘一点柔光（星轨划过） */}
                {progress > 0 && progress < 100 && <div className="comet-head" />}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text className="font-caption" style={{ fontSize: 13 }}>
                {getActiveLabel(status)}
                <span className="ellipsis-anim"><span>.</span><span>.</span><span>.</span></span>
              </Text>
              <Text className="font-mono" style={{ fontSize: 12, color: 'var(--mute)' }}>
                {progress}%
              </Text>
            </div>
          </>
        )}

        {/* 错误状态 */}
        {error && (
          <div style={{
            textAlign: 'center',
            padding: '16px 20px',
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
        <div style={{ marginTop: 28, textAlign: 'center' }}>
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

/* ── 子组件：步骤节点（圆点 + 标题 + 描述）── */
function StepNode({ index, done, active, error, title, description }) {
  const size = 32

  // 节点外观状态
  let circleStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 500,
    flexShrink: 0,
    position: 'relative',
    transition: 'all 0.3s ease',
  }
  let content = index + 1

  if (done) {
    // 完成：实心品牌色 + 打勾弹入
    circleStyle = {
      ...circleStyle,
      background: 'var(--accent)',
      color: '#fff',
    }
    content = <CheckOutlined className="check-pop" style={{ fontSize: 13 }} />
  } else if (active && !error) {
    // 进行中：实心品牌色 + 呼吸脉冲光环 + 转动指示
    circleStyle = {
      ...circleStyle,
      background: 'var(--accent)',
      color: '#fff',
      boxShadow: '0 0 0 4px var(--accent-light)',
    }
    content = <LoadingOutlined style={{ fontSize: 14 }} spin={false} className="node-spin" />
  } else if (error) {
    circleStyle = {
      ...circleStyle,
      background: 'var(--error)',
      color: '#fff',
    }
    content = '✕'
  } else {
    // 未开始：空心 hairline
    circleStyle = {
      ...circleStyle,
      background: 'var(--surface-1)',
      border: '1.5px solid var(--hairline-strong)',
      color: 'var(--mute)',
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 72, flexShrink: 0 }}>
      {/* 脉冲光环（仅进行中） */}
      <div style={{ position: 'relative' }}>
        {active && !error && <div className="pulse-ring" style={{ width: size, height: size }} />}
        <div style={circleStyle}>{content}</div>
      </div>
      {/* 标题 + 描述 */}
      <div style={{
        marginTop: 10,
        fontSize: 13,
        fontWeight: active || done ? 500 : 400,
        color: active ? 'var(--ink)' : done ? 'var(--body)' : 'var(--mute)',
        textAlign: 'center',
        transition: 'color 0.3s ease',
        whiteSpace: 'nowrap',
      }}>
        {title}
      </div>
      <div className="font-caption" style={{
        marginTop: 2,
        fontSize: 11,
        textAlign: 'center',
        whiteSpace: 'nowrap',
      }}>
        {description}
      </div>
    </div>
  )
}
