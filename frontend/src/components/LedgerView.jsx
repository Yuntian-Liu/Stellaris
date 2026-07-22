/**
 * 消耗记录 — 设置页二级界面
 * 分钟 / 量子波 / 引力波 三个分页签；量子波含赠送·永久双钱包拆分
 */
import { useState, useEffect, useCallback } from 'react'
import { Button, Tabs } from 'antd'
import {
  ArrowLeftOutlined, ClockCircleOutlined, DotChartOutlined, GlobalOutlined,
} from '@ant-design/icons'
import api from '../hooks/api'

const FEATURE_LABELS = {
  extract: '字幕提取',
  segment: '智能分段',
  summary: '总结概要',
  md: 'MD 笔记',
  chat: 'AI 解读',
  exchange: '货币兑换',
  signup_gift: '注册赠送',
  membership_gift: '会员赠送',
  admin_adjust: '管理员调整',
  redeem_gift: '兑换码会员赠送',
}

const CURRENCY_TABS = [
  { key: 'minute', Icon: ClockCircleOutlined, label: '分钟' },
  { key: 'quantum', Icon: DotChartOutlined, label: '量子波' },
  { key: 'gravity', Icon: GlobalOutlined, label: '引力波' },
]

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)   // 后端已补 'Z'，浏览器按本地时区渲染
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 量子波双钱包拆分说明（如 "赠送 -2 · 永久 +0"） */
function walletNote(item) {
  if (item.currency !== 'quantum' || item.from_gift == null) return null
  const fmt = (v) => (v > 0 ? `+${v}` : `${v}`)
  return `赠送 ${fmt(item.from_gift)} · 永久 ${fmt(item.from_perm ?? 0)}`
}

export default function LedgerView({ onBack, initialTab = 'minute' }) {
  const [tab, setTab] = useState(initialTab)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (currency, p) => {
    setLoading(true)
    try {
      const r = await api.getLedger(p, 20, currency)
      setItems(prev => (p === 1 ? r.items : [...prev, ...r.items]))
      setTotal(r.total)
      setPage(r.page)
    } catch { /* 静默：空态兜底 */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(tab, 1) }, [tab, load])

  return (
    <div style={{ maxWidth: 560, margin: '-14px auto 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <h1 className="font-display font-display-sm" style={{ margin: 0 }}>消耗记录</h1>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={CURRENCY_TABS.map(({ key, Icon, label }) => ({
          key,
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Icon style={{ fontSize: 12 }} />{label}
            </span>
          ),
        }))}
      />

      <div className="card" style={{ padding: '4px 18px' }}>
        {items.length === 0 && !loading && (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
            暂无记录
          </div>
        )}
        {items.map((it, i) => {
          const meta = CURRENCY_TABS.find(c => c.key === it.currency) || CURRENCY_TABS[0]
          const note = walletNote(it)
          return (
            <div key={it.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
            }}>
              <meta.Icon style={{ color: 'var(--accent)', fontSize: 14, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--ink)' }}>
                  {FEATURE_LABELS[it.feature] || it.feature}
                </div>
                {note && (
                  <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>
                    {note}
                  </div>
                )}
                {it.note && (
                  <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>
                    {it.note}
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="font-mono" style={{
                  fontSize: 14, fontWeight: 600,
                  color: it.amount > 0 ? '#16a34a' : 'var(--ink)',
                }}>
                  {it.amount > 0 ? `+${it.amount}` : it.amount}
                </div>
                <div className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', marginTop: 1 }}>
                  余 {it.balance_after} · {fmtTime(it.created_at)}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {items.length < total && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <Button size="small" loading={loading} onClick={() => load(tab, page + 1)}>
            加载更多（{items.length}/{total}）
          </Button>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--mute)', textAlign: 'center', marginTop: 14, lineHeight: 1.7 }}>
        流水永久保存，不随任务清理删除 · 失败操作零扣费
      </div>
    </div>
  )
}
