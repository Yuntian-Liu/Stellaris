/**
 * 计费三胶囊 — 导航栏余额展示
 * [🕐 N分钟] [🌀 引力波] [✦ 量子波]
 * 分钟胶囊：显示当日剩余，hover 展开日/周/月进度条
 * 引力波胶囊：纯显示（永不过期）
 * 量子波胶囊：显示总数，hover 拆赠送/活动钱包 + 兑换入口（弹窗双向兑换）
 */
import { useState, useEffect } from 'react'
import { Popover, Tooltip, Progress, Button } from 'antd'
import {
  ClockCircleOutlined, GlobalOutlined, DotChartOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'
import ExchangeModal from './ExchangeModal'

const pillStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 12px',
  background: 'var(--surface-1)',
  border: '1px solid var(--hairline)',
  borderRadius: '9999px',
  cursor: 'default',
  fontSize: 12,
}

export default function BillingPills({ onOpenLedger }) {
  const [data, setData] = useState(null)
  const [exchangeOpen, setExchangeOpen] = useState(false)
  const [exchangeTab, setExchangeTab] = useState('q2g')

  const load = () => api.getBilling().then(setData).catch(() => {})
  useEffect(() => {
    load()
    // 任何组件完成兑换/扣费后广播此事件 → 同步刷新
    const handler = () => load()
    window.addEventListener('stellaris:billing-changed', handler)
    return () => window.removeEventListener('stellaris:billing-changed', handler)
  }, [])

  if (!data) return null

  const { minutes, quantum_gift, quantum_perm, gravity, unlimited } = data
  // ∞ 用衬线字体渲染并放大：等宽字体里的 ∞ 又小又呆
  const INF = (
    <span style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontSize: 15, lineHeight: 1 }}>∞</span>
  )
  // 胶囊显示第一个有上限周期的余量（Stella 日/周不限 → 显示月余量）；全不限 → ∞
  const pillLeft = [minutes.day, minutes.week, minutes.month]
    .map(m => (m.limit == null ? null : m.limit - m.used))
    .find(v => v !== null)
  const dayLeft = pillLeft ?? INF
  const quantumTotal = quantum_gift + quantum_perm
  const openExchange = (tab) => { setExchangeTab(tab); setExchangeOpen(true) }

  return (
    <>
      {/* ── 分钟胶囊 ── */}
      <Popover
        placement="bottomRight"
        content={
          <div style={{ width: 230, padding: '2px 0' }}>
            {[['日', minutes.day], ['周', minutes.week], ['月', minutes.month]].map(([label, m]) => {
              const noCap = m.limit == null   // 该周期不限（admin 全不限 / Stella 日周不限）
              return (
              <div key={label} style={{ marginBottom: 12 }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  fontSize: 12, marginBottom: 3,
                }}>
                  <span style={{ color: 'var(--mute)' }}>{label}限额</span>
                  <span className="font-mono" style={{ color: 'var(--body)' }}>
                    {noCap ? <>{m.used} / {INF}</> : `${m.used} / ${m.limit}`} 分钟
                  </span>
                </div>
                <Progress
                  percent={noCap ? 100 : Math.round(m.used / m.limit * 100)}
                  showInfo={false}
                  size="small"
                  strokeColor={
                    noCap
                      ? { '0%': '#c7d2fe', '100%': '#a5b4fc' }   // 不限量：浅蓝满条，表"无界"
                      : (m.used / m.limit > 0.8 ? '#f59e0b' : 'var(--accent)')
                  }
                />
              </div>
              )
            })}
            <div style={{ fontSize: 11, color: 'var(--mute)', lineHeight: 1.6 }}>
              {unlimited
                ? '分钟不限量 · 消耗照常记账'
                : '每日 04:00 / 每周一 04:00 / 每月 1 日 04:00 重置（UTC+8）'}
            </div>
            <div style={{ marginTop: 6, textAlign: 'right' }}>
              <a onClick={() => onOpenLedger?.('minute')} style={{ fontSize: 11 }}>消耗记录 →</a>
            </div>
          </div>
        }
      >
        <div style={pillStyle}>
          <ClockCircleOutlined style={{ color: 'var(--accent)', fontSize: 12 }} />
          <span style={{ color: 'var(--mute)' }}>分钟</span>
          <span className="font-mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>{dayLeft}</span>
        </div>
      </Popover>

      {/* ── 引力波胶囊（点击可反向兑换）── */}
      <Popover
        placement="bottomRight"
        content={
          <div style={{ width: 200, fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            高级功能货币 · 永不过期
            <div style={{ marginTop: 6 }}>
              <a onClick={() => openExchange('g2q')} style={{ fontSize: 12 }}>兑换量子波（1:20）→</a>
            </div>
            <div style={{ marginTop: 4 }}>
              <a onClick={() => onOpenLedger?.('gravity')} style={{ fontSize: 12 }}>消耗记录 →</a>
            </div>
          </div>
        }
      >
        <div style={{ ...pillStyle, cursor: 'pointer' }}>
          <GlobalOutlined style={{ color: 'var(--accent)', fontSize: 12 }} />
          <span style={{ color: 'var(--mute)' }}>引力波</span>
          <span className="font-mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>{gravity}</span>
        </div>
      </Popover>

      {/* ── 量子波胶囊 ── */}
      <Popover
        placement="bottomRight"
        content={
          <div style={{ width: 240 }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 12, marginBottom: 8,
            }}>
              <span style={{ color: 'var(--mute)' }}>本周赠送（周一 04:00 清零）</span>
              <span className="font-mono" style={{ color: 'var(--body)' }}>{quantum_gift}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              fontSize: 12, marginBottom: 4,
            }}>
              <span style={{ color: 'var(--mute)' }}>永久余额</span>
              <span className="font-mono" style={{ color: 'var(--body)' }}>{quantum_perm}</span>
            </div>
            <div style={{
              borderTop: '1px dashed var(--hairline)', paddingTop: 10, marginTop: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 11, color: 'var(--mute)' }}>
                {data.exchange_month_cap == null
                  ? '25:1 兑换引力波 · 不限次'
                  : `25:1 兑换引力波 · 本月还可兑 ${data.exchange_month_cap - data.exchange_month_used} 次`}
              </span>
              <Button size="small" type="primary" ghost onClick={() => openExchange('q2g')}>
                兑换
              </Button>
            </div>
            <div style={{ marginTop: 6, textAlign: 'right' }}>
              <a onClick={() => onOpenLedger?.('quantum')} style={{ fontSize: 11 }}>消耗记录 →</a>
            </div>
          </div>
        }
      >
        <div style={pillStyle}>
          <DotChartOutlined style={{ color: 'var(--accent)', fontSize: 12 }} />
          <span style={{ color: 'var(--mute)' }}>量子波</span>
          <span className="font-mono" style={{ color: 'var(--ink)', fontWeight: 600 }}>{quantumTotal}</span>
        </div>
      </Popover>

      <ExchangeModal
        open={exchangeOpen}
        defaultTab={exchangeTab}
        billing={data}
        onClose={() => setExchangeOpen(false)}
        onDone={load}
      />
    </>
  )
}
