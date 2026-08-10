/**
 * 转存到文件柜控件（文件柜用户开放内测）
 *
 * 两种形态：
 *   - mode="download"：单个「下载」按钮（外观与原版完全一致），hover/点击浮出
 *     「下载文件 / 转存到文件柜」双选项——不新增任何按钮
 *   - mode="icon"：单个图标按钮（AI 解读面板顶栏用），点击即转存
 *
 * 权限逻辑（未开通判断优先用 /vault/status，查询失败放行由 store 的 403 兜底）：
 *   - 未登录：点击 → message 引导 + onNeedAuth 跳登录
 *   - 已登录未开通：转存项灰态禁用 + ⓘ 图标，点 ⓘ 弹简介浮窗（含「去申请」跳设置页实验室）
 *   - 已开通：弹转存窗（文件名预填 + 目标文件夹）→ POST /api/vault/store
 */
import { useState, useEffect } from 'react'
import { AutoComplete, Button, Dropdown, Input, Modal, message } from 'antd'
import { InfoCircleOutlined, CloudUploadOutlined, DownloadOutlined } from '@ant-design/icons'
import { vaultApi, getToken } from '../hooks/api'
import { useAuth } from '../contexts/AuthContext'

/* /vault/status 模块级缓存（30s，按 token 隔离）：结果页多个下载行共用一次查询 */
let statusCache = null   // { token, ts, data }
async function fetchVaultStatus() {
  const token = getToken()
  if (!token) return null
  if (statusCache && statusCache.token === token && Date.now() - statusCache.ts < 30000) {
    return statusCache.data
  }
  try {
    const data = await vaultApi.status()
    statusCache = { token, ts: Date.now(), data }
    return data
  } catch {
    return null   // 查询失败按"未知"处理：不灰禁用，让 store 的后端校验说话
  }
}

const fieldLabel = { fontSize: 12, color: 'var(--mute)', marginBottom: 6 }

export default function VaultStoreControl({
  mode = 'download',
  taskId, kind, suffix,          // suffix：预填文件名的种类后缀（笔记.md / 概要.md / 全文.txt / 字幕.srt / 解读.md）
  videoTitle,
  onDownload,                    // download 模式「下载文件」选项的行为
  buttonProps = {},              // download 模式透传给按钮（type/icon/size/title）
  buttonLabel = '下载',          // 按钮文字；传 null = 纯图标按钮（ChatPanel 顶栏）
  buttonStyle = {},              // 额外的按钮样式覆盖
  storeReady = true,             // false → 转存项禁用（产物未生成）
  disabled = false,              // 外部禁用（数据已清理 / 对话为空）
  onNeedAuth,
}) {
  const { user } = useAuth()
  const [status, setStatus] = useState(undefined)   // undefined=加载中，null=未登录/查询失败
  const [storeOpen, setStoreOpen] = useState(false)
  const [introOpen, setIntroOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)   // 受控下拉：开弹窗前先收菜单（碳碳实测：弹窗与菜单不应共存）
  const [filename, setFilename] = useState('')
  const [folder, setFolder] = useState('')
  const [folderOptions, setFolderOptions] = useState([])   // 已有文件夹（转存弹窗下拉用）
  const [saving, setSaving] = useState(false)

  /** 打开简介浮窗（先收菜单，避免双层浮层叠着） */
  const openIntro = () => { setMenuOpen(false); setIntroOpen(true) }

  useEffect(() => {
    if (!user) { setStatus(null); return }
    let alive = true
    fetchVaultStatus().then((d) => { if (alive) setStatus(d) })
    return () => { alive = false }
  }, [user])

  // 已知未开通（查到了状态且 enabled=false）；加载中/查询失败不拦截，由后端 403 兜底
  const notEnabled = !!user && !!status && !status.enabled

  const openStore = () => {
    setFilename(`${videoTitle || '未命名'}-${suffix}`)
    setFolder('')
    // 拉已有文件夹做下拉（失败静默——仍可手输）
    vaultApi.list('').then((r) => setFolderOptions(r.folders || [])).catch(() => {})
    setStoreOpen(true)
  }

  /** 转存入口统一闸：未登录引导登录；未开通弹简介；已开通弹转存窗 */
  const handleStoreClick = () => {
    if (!user) {
      message.info('文件柜是登录用户功能，登录后即可把结果存到云端')
      onNeedAuth?.()
      return
    }
    if (notEnabled) { openIntro(); return }
    openStore()
  }

  const submitStore = async () => {
    const name = filename.trim()
    if (!name || saving) return
    setSaving(true)
    try {
      const f = folder.trim().replace(/^\/+|\/+$/g, '')
      const r = await vaultApi.store({
        task_id: taskId,
        kind,
        filename: name,
        ...(f ? { folder: f } : {}),
      })
      message.success(`已存入文件柜：${r.path}`)
      setStoreOpen(false)
    } catch (e) {
      // 403 未开通 / 404 产物不存在 / 413 超 1MB / 409 配额满（detail 带用量文案）/ 429 太频繁
      message.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const modals = (
    <>
      {/* 转存窗：文件名（预填可改）+ 目标文件夹（默认根目录） */}
      <Modal
        open={storeOpen}
        onCancel={() => setStoreOpen(false)}
        onOk={submitStore}
        okText="存入"
        cancelText="取消"
        width={420}
        centered
        title="转存到文件柜"
        okButtonProps={{ disabled: !filename.trim(), loading: saving }}
      >
        <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={fieldLabel}>文件名</div>
            <Input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onPressEnter={submitStore}
            />
          </div>
          <div>
            <div style={fieldLabel}>目标文件夹</div>
            <AutoComplete
              value={folder}
              onChange={setFolder}
              placeholder="留空 = 根目录；可选已有文件夹或输入新文件夹"
              options={folderOptions.map((f) => ({ value: f, label: f }))}
              filterOption={(input, option) => option.value.includes(input)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            存入后可在「设置 → 星轨实验室 → 文件柜」在线查看渲染版。
          </div>
        </div>
      </Modal>

      {/* 未开通简介浮窗：简介 + 去申请（事件总线跳设置页实验室，App 监听） */}
      <Modal
        open={introOpen}
        onCancel={() => setIntroOpen(false)}
        footer={null}
        width={360}
        centered
        title="文件柜 · 内测中"
      >
        <div style={{ fontSize: 13, color: 'var(--body)', lineHeight: 1.9, padding: '4px 0 16px' }}>
          文件柜：把你的提取结果存在云端，随时在线查看渲染版。
          内测名额由开发者人工开通，先到先得。
        </div>
        <Button
          type="primary"
          block
          onClick={() => {
            setIntroOpen(false)
            window.dispatchEvent(new CustomEvent('stellaris:open-lab'))
          }}
        >
          去申请
        </Button>
      </Modal>
    </>
  )

  /* ── icon 模式（AI 解读面板顶栏）── */
  if (mode === 'icon') {
    return (
      <>
        {notEnabled ? (
          /* 未开通：灰态禁用 + ⓘ 弹简介浮窗 */
          <>
            <Button type="text" size="small" icon={<CloudUploadOutlined />} disabled title="转存到文件柜" />
            <Button
              type="text" size="small" icon={<InfoCircleOutlined style={{ color: 'var(--accent)' }} />}
              onClick={() => setIntroOpen(true)} title="什么是文件柜？"
            />
          </>
        ) : (
          <Button
            type="text" size="small" icon={<CloudUploadOutlined />}
            disabled={disabled}
            onClick={handleStoreClick}
            title="转存到文件柜"
          />
        )}
        {modals}
      </>
    )
  }

  /* ── download 模式：单个「下载」按钮，hover/点击浮出双选项（不新增任何按钮）── */
  const menuItems = [
    { key: 'download', icon: <DownloadOutlined />, label: '下载文件' },
    {
      key: 'store',
      disabled: !storeReady || notEnabled,
      label: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          转存到文件柜
          {notEnabled && (
            <InfoCircleOutlined
              style={{ color: 'var(--accent)' }}
              onClick={(e) => { e.stopPropagation(); openIntro() }}
            />
          )}
        </span>
      ),
    },
  ]

  return (
    <>
      <Dropdown
        open={menuOpen}
        onOpenChange={setMenuOpen}
        menu={{
          items: menuItems,
          onClick: ({ key }) => {
            setMenuOpen(false)
            if (key === 'download') onDownload?.()
            if (key === 'store') handleStoreClick()
          },
        }}
        trigger={['hover', 'click']}
        placement="bottomRight"
      >
        <Button
          {...buttonProps}
          disabled={disabled}
          style={{
            ...(buttonLabel ? { minWidth: 96, height: 38, borderRadius: 'var(--r-btn)', fontWeight: 500 } : {}),
            ...buttonStyle,
          }}
        >
          {buttonLabel}
        </Button>
      </Dropdown>
      {modals}
    </>
  )
}
