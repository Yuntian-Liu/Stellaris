/**
 * 双向兑换弹窗 — 量子波 ⇄ 引力波
 * q2g: 25:1，每月限 5 次；g2q: 1:20，不限次
 * 带消耗/获得预览，确认后才执行
 */
import { useState, useEffect } from 'react'
import { Modal, Button, InputNumber, Tabs, message, Popconfirm } from 'antd'
import { GlobalOutlined, DotChartOutlined, SwapOutlined } from '@ant-design/icons'
import api from '../hooks/api'

export default function ExchangeModal({ open, defaultTab = 'q2g', billing, onClose, onDone }) {
  const [tab, setTab] = useState(defaultTab)
  const [count, setCount] = useState(1)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) { setTab(defaultTab); setCount(1) }
  }, [open, defaultTab])

  if (!billing) return null
  const quantumTotal = billing.quantum_gift + billing.quantum_perm
  const monthLeft = billing.exchange_month_cap - billing.exchange_month_used

  // 当前方向的兑换规则
  const isQ2G = tab === 'q2g'
  const rateText = isQ2G ? '25 量子波 → 1 引力波' : '1 引力波 → 20 量子波'
  const cost = isQ2G ? count * 25 : count
  const gain = isQ2G ? count : count * 20
  const maxCount = isQ2G
    ? Math.min(Math.floor(quantumTotal / 25), monthLeft)
    : billing.gravity
  const canExchange = count >= 1 && count <= maxCount

  const doExchange = async () => {
    setLoading(true)
    try {
      await api.exchange(tab, count)
      message.success(isQ2G ? `兑换成功：+${gain} 引力波` : `兑换成功：+${gain} 量子波`)
      // 广播余额变更，所有展示组件（胶囊/设置页）同步刷新
      window.dispatchEvent(new CustomEvent('stellaris:billing-changed'))
      onDone?.()
      onClose()
    } catch (e) {
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="货币兑换" width={400} centered>
      <Tabs
        activeKey={tab}
        onChange={(k) => { setTab(k); setCount(1) }}
        items={[
          { key: 'q2g', label: '量子波 → 引力波' },
          { key: 'g2q', label: '引力波 → 量子波' },
        ]}
      />

      <div style={{
        background: 'var(--surface-2)', borderRadius: 'var(--r-input)',
        padding: '10px 14px', fontSize: 13, color: 'var(--body)',
        marginBottom: 14, lineHeight: 1.7,
      }}>
        <SwapOutlined style={{ marginRight: 8, color: 'var(--accent)' }} />
        {rateText}
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 4 }}>
          {isQ2G
            ? `本月还可兑 ${monthLeft} 次 · 当前量子波 ${quantumTotal}`
            : `不限次数 · 当前引力波 ${billing.gravity} · 换得的量子波永不过期`}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 13, color: 'var(--mute)' }}>兑换数量</span>
        <InputNumber
          min={1} max={Math.max(1, maxCount)} value={count}
          onChange={(v) => setCount(v || 1)}
          style={{ width: 90 }}
        />
        <Button size="small" type="link" disabled={maxCount < 1} onClick={() => setCount(Math.max(1, maxCount))}>
          全部
        </Button>
      </div>

      {/* 预览 */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px', marginBottom: 16,
        border: '1px dashed var(--hairline-strong)', borderRadius: 'var(--r-input)',
        fontSize: 13,
      }}>
        <span style={{ color: 'var(--error)' }}>
          <DotChartOutlined /> −{cost} {isQ2G ? '量子波' : '引力波'}
        </span>
        <span style={{ color: 'var(--mute)' }}>→</span>
        <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
          <GlobalOutlined /> +{gain} {isQ2G ? '引力波' : '量子波'}
        </span>
      </div>

      <Popconfirm
        title="确认兑换？"
        description={`确定用 ${cost} ${isQ2G ? '量子波' : '引力波'} 兑换 ${gain} ${isQ2G ? '引力波' : '量子波'} 吗？`}
        okText="确认兑换"
        cancelText="再想想"
        onConfirm={doExchange}
        disabled={!canExchange}
      >
        <Button
          type="primary" block size="large"
          loading={loading} disabled={!canExchange}
        >
          {maxCount < 1 ? '余额不足或本月已兑满' : '确认兑换'}
        </Button>
      </Popconfirm>
    </Modal>
  )
}
