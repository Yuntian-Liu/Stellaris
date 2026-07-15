/**
 * 页面 3：结果页 — Starlight 设计系统
 *
 * 极简完成态：纯色圆底 + 无阴影图标 + 衬线标题
 */
import { useState } from 'react'
import {
  Typography, Button, Space, Tabs, Tag,
  message, Descriptions,
} from 'antd'
import {
  DownloadOutlined,
  ArrowLeftOutlined,
  ReloadOutlined,
  FileTextOutlined,
  FileOutlined,
  CheckCircleFilled,
} from '@ant-design/icons'
import api from '../hooks/api'

const { Text } = Typography

export default function ResultPage({ taskData, onBack, onNew }) {
  const [activeTab, setActiveTab] = useState('preview')

  const handleDownload = async (format) => {
    try {
      const url = api.getDownloadUrl(taskData.task_id, format)
      const a = document.createElement('a')
      a.href = url
      a.download = `stellaris-${taskData.task_id}.${format}`
      a.click()
      message.success(`已下载 ${format.toUpperCase()}`)
    } catch (e) {
      message.error('下载失败：' + e.message)
    }
  }

  const sourceMap = {
    cc_subtitle: { text: 'CC 字幕', color: 'var(--success)', bg: 'var(--success-bg)' },
    asr_mimo: { text: 'Mimo ASR', color: 'var(--accent)', bg: 'var(--accent-light)' },
  }
  const source = sourceMap[taskData.subtitle_source] || { text: '未知', color: 'var(--mute)', bg: 'var(--surface-2)' }

  return (
    <div>
      {/* ── 完成标识：极简，无渐变无阴影 ── */}
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
          labelStyle={{ ...{ fontSize: 13 }, color: 'var(--mute)' }}
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

        {/* Tab 切换 */}
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'preview',
              label: (
                <span><FileTextOutlined /> 预览</span>
              ),
              children: (
                <div style={{
                  background: 'var(--surface-2)',
                  borderRadius: 'var(--r-input)',
                  padding: 18,
                  maxHeight: 360,
                  overflowY: 'auto',
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: 13,
                  lineHeight: 1.85,
                  color: 'var(--ink)',
                  whiteSpace: 'pre-wrap',
                  border: '1px solid var(--hairline)',
                }}>
                  {taskData.subtitle_txt || '字幕内容加载中...'}
                </div>
              ),
            },
            {
              key: 'download',
              label: (
                <span><FileOutlined /> 下载</span>
              ),
              children: (
                <div style={{ padding: '28px 0', textAlign: 'center' }}>
                  <Space direction="vertical" size={18}>
                    {/* SRT 下载 */}
                    <div>
                      <Button
                        type="primary"
                        size="large"
                        icon={<DownloadOutlined />}
                        onClick={() => handleDownload('srt')}
                        style={{
                          minWidth: 200,
                          height: 44,
                          fontWeight: 500,
                          borderRadius: 'var(--r-btn)',
                        }}
                      >
                        下载 SRT 字幕文件
                      </Button>
                      <p className="font-caption" style={{ margin: '5px 0 0' }}>
                        含时间轴，可导入播放器 / 编辑器
                      </p>
                    </div>

                    {/* TXT 下载 */}
                    <div>
                      <Button
                        size="large"
                        icon={<DownloadOutlined />}
                        onClick={() => handleDownload('txt')}
                        style={{
                          minWidth: 200,
                          height: 40,
                          borderRadius: 'var(--r-btn)',
                          background: 'var(--surface-1)',
                          borderColor: 'var(--hairline)',
                          color: 'var(--ink)',
                        }}
                      >
                        下载 TXT 纯文本
                      </Button>
                      <p className="font-caption" style={{ margin: '5px 0 0' }}>
                        纯文字内容，方便阅读 / 搜索
                      </p>
                    </div>
                  </Space>
                </div>
              ),
            },
          ]}
        />

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
          ✦ Stellaris · Made with care
        </Text>
      </div>
    </div>
  )
}
