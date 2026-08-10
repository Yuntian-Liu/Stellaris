/**
 * 用户版文件柜（星轨实验室 · 开放内测）
 *
 * 结构/样式复用管理端 VaultPanel（AdminView），差异：
 *   - 无专用密码闸：登录 JWT 即权限，401 走 request() 默认行为（清登录态跳登录）
 *   - 无上传区：新增文件只能来自结果页 / AI 解读的「转存到文件柜」
 *   - 保留：面包屑 / 文件夹+文件列表 / 阅读区（MD 渲染↔原文）/ 下载 / 重命名 / 删除 / 新建虚拟文件夹
 *   - 顶部：QuotaBar（usedBytes + quota_mb）+ 文件数
 */
import { useState, useEffect, useCallback } from 'react'
import { Button, Input, Modal, Radio, Empty, message } from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined, FolderAddOutlined,
  FolderOutlined, FileOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'
import { vaultApi } from '../hooks/api'
import QuotaBar from './QuotaBar'
import VaultGuideModal from './VaultGuideModal'
import { MD_COMPONENTS, normalizeLatex } from '../pages/ResultPage'

const GUIDE_SEEN_KEY = 'stellaris_vault_guide_seen'

const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—')

const fmtTimeShort = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)   // 后端已补 'Z'，浏览器按本地时区渲染
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 文件夹名校验（黑名单制，镜像后端 validate_path：禁 / 和 \ 和 .. 段，其余含中文括号逗号空格都允许） */
function folderNameError(name) {
  if (!name) return null   // 空不提示，由按钮禁用兜底
  if (name.includes('/')) return '只支持单级文件夹，名称不能包含 /'
  if (name.includes('\\')) return '名称不能包含反斜杠'
  if (name.trim() === '..') return '文件夹名不允许为 ..'
  if (name.trim().length > 64) return '最多 64 字符'
  return null
}

export default function UserVaultPanel() {
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState(null)    // {folders, files, total, quota_mb}
  const [viewing, setViewing] = useState(null)    // {path, content, size, updated_at}
  const [mdMode, setMdMode] = useState('render')
  const [renameFor, setRenameFor] = useState(null)
  const [renameTo, setRenameTo] = useState('')
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [freshFolder, setFreshFolder] = useState(null)   // 刚"新建"进入的虚拟文件夹路径（空态提示用）
  // 引导页：首次进入自动弹出（每设备一次），工具行可随时重开
  const [guideOpen, setGuideOpen] = useState(() => {
    try { return !localStorage.getItem(GUIDE_SEEN_KEY) } catch { return false }
  })
  const closeGuide = () => {
    setGuideOpen(false)
    try { localStorage.setItem(GUIDE_SEEN_KEY, '1') } catch { /* 静默 */ }
  }

  const load = useCallback(async (p) => {
    try {
      const r = await vaultApi.list(p ?? prefix)
      setListing(r)
      setPrefix(r.prefix)
    } catch (e) {
      message.error(e.message)
    }
  }, [prefix])

  // 挂载拉根目录；之后靠面包屑/行点击带参导航（401 由 request 默认行为兜底跳登录）
  useEffect(() => { load('') }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 查看 / 下载 / 重命名 / 删除 ── */

  const openFile = async (path) => {
    try {
      const r = await vaultApi.get(path)
      setViewing(r)
      setMdMode('render')
    } catch (e) {
      message.error(e.message)
    }
  }

  const downloadFile = async (path) => {
    try {
      const r = await vaultApi.get(path)
      const url = URL.createObjectURL(new Blob([r.content], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = path.split('/').pop()   // 文件名单段
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      message.error(e.message)
    }
  }

  const submitRename = async () => {
    const to = renameTo.trim().replace(/^\/+|\/+$/g, '')
    if (!to || to === renameFor) { setRenameFor(null); return }
    try {
      await vaultApi.rename({ from: renameFor, to })
      message.success('已重命名')
      setRenameFor(null)
      if (viewing?.path === renameFor) setViewing(null)   // 阅读中的文件被改名/移动，回列表
      load()
    } catch (e) {
      message.error(e.message)
    }
  }

  const removeFile = (path) => {
    Modal.confirm({
      centered: true,
      title: '删除文件？',
      content: `「${path}」删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await vaultApi.remove({ path })
          message.success('已删除')
          if (viewing?.path === path) setViewing(null)
          load()
        } catch (e) {
          message.error(e.message)
        }
      },
    })
  }

  /** 递归统计文件夹下文件数（后端 list 不递归，逐层统计给删除确认文案用） */
  const countFiles = async (p) => {
    const r = await vaultApi.list(p)
    let n = r.files.length
    for (const f of r.folders) n += await countFiles(r.prefix ? `${r.prefix}/${f}` : f)
    return n
  }

  const removeFolder = async (name) => {
    const folderPath = prefix ? `${prefix}/${name}` : name
    let countText = '其下全部文件'
    try {
      countText = `其下全部 ${await countFiles(folderPath)} 个文件`
    } catch { /* 统计失败用兜底文案，不阻塞删除 */ }
    Modal.confirm({
      centered: true,
      title: `删除文件夹「${name}」？`,
      content: `将删除${countText}，不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await vaultApi.remove({ prefix: folderPath })
          message.success('文件夹已删除')
          load()
        } catch (e) {
          message.error(e.message)
        }
      },
    })
  }

  /**
   * 新建文件夹：虚拟机制（后端无文件夹实体）——纯前端导航进入新路径，
   * 转存第一个文件后才真实存在；直接离开则自动消失（符合预期）。
   */
  const createFolder = () => {
    const name = newFolderName.trim()
    if (!name || folderNameError(name)) return
    if (listing?.folders.includes(name)) { message.warning('当前目录已存在同名文件夹'); return }
    const p = prefix ? `${prefix}/${name}` : name
    setMkdirOpen(false)
    setNewFolderName('')
    setViewing(null)
    setFreshFolder(p)
    load(p)
  }

  /* ── 渲染 ── */

  const crumbs = prefix ? prefix.split('/') : []
  const isMd = viewing?.path?.toLowerCase().endsWith('.md')
  const rowStyle = {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 10px', borderBottom: '1px solid var(--hairline)',
    flexWrap: 'wrap',   // 移动端操作按钮换行，不硬挤
  }

  return (
    <div>
      {/* 工具行：面包屑 + 文件数/配额 + 新建文件夹 + 刷新 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexWrap: 'wrap' }}>
          <span
            onClick={() => { setViewing(null); load('') }}
            style={{ cursor: 'pointer', fontWeight: 500, color: crumbs.length ? 'var(--accent)' : 'var(--ink)' }}
          >文件柜</span>
          {crumbs.map((seg, i) => {
            const p = crumbs.slice(0, i + 1).join('/')
            const last = i === crumbs.length - 1
            return (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--mute)' }}>/</span>
                <span
                  onClick={() => { if (!last) { setViewing(null); load(p) } }}
                  style={{ cursor: last ? 'default' : 'pointer', color: last ? 'var(--ink)' : 'var(--accent)', fontWeight: last ? 500 : 400 }}
                >{seg}</span>
              </span>
            )
          })}
        </div>
        <span style={{ flex: 1 }} />
        {listing?.total && (
          <span className="font-caption" style={{ fontSize: 12, color: 'var(--mute)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            共 {listing.total.files} 个文件
            <QuotaBar usedBytes={listing.total.used_bytes} quotaMb={listing.quota_mb} width={110} />
          </span>
        )}
        <Button size="small" icon={<FolderAddOutlined />} onClick={() => setMkdirOpen(true)}>新建文件夹</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => load()}>刷新</Button>
        <Button size="small" type="text" onClick={() => setGuideOpen(true)}>介绍</Button>
      </div>

      {viewing ? (
        /* 阅读区 */
        <div className="card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setViewing(null)}>返回列表</Button>
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 500, wordBreak: 'break-all' }}>{viewing.path}</span>
            <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>
              {fmtSize(viewing.size)} · {fmtTime(viewing.updated_at)}
            </span>
            <span style={{ flex: 1 }} />
            {isMd && (
              <Radio.Group size="small" value={mdMode} onChange={(e) => setMdMode(e.target.value)}>
                <Radio.Button value="render">渲染</Radio.Button>
                <Radio.Button value="raw">原文</Radio.Button>
              </Radio.Group>
            )}
            <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadFile(viewing.path)}>下载</Button>
          </div>
          {isMd && mdMode === 'render' ? (
            <div style={{ padding: '4px 2px' }}>
              <ReactMarkdown
                components={MD_COMPONENTS}
                remarkPlugins={[remarkMath, remarkGfm]}
                rehypePlugins={[rehypeKatex]}
              >{normalizeLatex(viewing.content)}</ReactMarkdown>
            </div>
          ) : (
            <pre className="font-mono" style={{
              background: 'var(--surface-1)', padding: '10px 14px', borderRadius: 8,
              fontSize: 13, lineHeight: 1.7, overflowX: 'auto', margin: 0,
              border: '1px solid var(--hairline)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>{viewing.content}</pre>
          )}
        </div>
      ) : (
        /* 列表：文件夹 + 文件（无上传区——新增只能来自结果页转存） */
        <div className="card" style={{ padding: '4px 8px' }}>
          {!listing ? (
            <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--mute)', fontSize: 12 }}>加载中…</div>
          ) : (listing.folders.length + listing.files.length === 0) ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={freshFolder === prefix
                ? '这是一个新文件夹，从结果页转存第一个文件后即创建'
                : '空目录 — 在结果页点「转存到文件柜」把结果存进来'}
              style={{ padding: '20px 0' }}
            />
          ) : (
            <>
              {listing.folders.map((name) => (
                <div key={`d-${name}`} style={rowStyle}>
                  <FolderOutlined style={{ color: 'var(--accent)', fontSize: 15 }} />
                  <span
                    onClick={() => { setViewing(null); load(prefix ? `${prefix}/${name}` : name) }}
                    style={{ cursor: 'pointer', fontWeight: 500, color: 'var(--ink)', fontSize: 13, flex: 1, wordBreak: 'break-all' }}
                  >{name}</span>
                  <Button size="small" type="text" danger onClick={() => removeFolder(name)}>删除</Button>
                </div>
              ))}
              {listing.files.map((f) => (
                <div key={`f-${f.path}`} style={rowStyle}>
                  <FileOutlined style={{ color: 'var(--mute)', fontSize: 14 }} />
                  <span
                    onClick={() => openFile(f.path)}
                    style={{ cursor: 'pointer', color: 'var(--ink)', fontSize: 13, wordBreak: 'break-all' }}
                  >{f.name}</span>
                  <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>{fmtSize(f.size)}</span>
                  <span className="font-mono" style={{ fontSize: 11, color: 'var(--mute)', flexShrink: 0 }}>{fmtTimeShort(f.updated_at)}</span>
                  <span style={{ flex: 1 }} />
                  <Button size="small" type="text" onClick={() => openFile(f.path)}>查看</Button>
                  <Button size="small" type="text" onClick={() => downloadFile(f.path)}>下载</Button>
                  <Button size="small" type="text" onClick={() => { setRenameFor(f.path); setRenameTo(f.path) }}>重命名</Button>
                  <Button size="small" type="text" danger onClick={() => removeFile(f.path)}>删除</Button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* 重命名/移动弹窗（改文件夹段 = 移动） */}
      <Modal
        open={!!renameFor}
        onCancel={() => setRenameFor(null)}
        onOk={submitRename}
        okText="确定"
        cancelText="取消"
        width={420}
        centered
        title="重命名 / 移动"
      >
        <div style={{ paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 8, lineHeight: 1.7 }}>
            修改路径中的文件夹部分即可移动文件；目标已存在同名文件会被拒绝。
          </div>
          <Input
            className="font-mono"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onPressEnter={submitRename}
          />
        </div>
      </Modal>

      {/* 新建文件夹弹窗（虚拟文件夹：确认即导航进入，转存首文件后才真实存在） */}
      <Modal
        open={mkdirOpen}
        onCancel={() => { setMkdirOpen(false); setNewFolderName('') }}
        onOk={createFolder}
        okText="进入文件夹"
        cancelText="取消"
        width={380}
        centered
        title="新建文件夹"
        okButtonProps={{ disabled: !newFolderName.trim() || !!folderNameError(newFolderName.trim()) }}
      >
        <div style={{ paddingTop: 8 }}>
          <Input
            placeholder="文件夹名（单级）"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onPressEnter={createFolder}
            status={folderNameError(newFolderName.trim()) ? 'error' : ''}
          />
          {folderNameError(newFolderName.trim()) && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--error)' }}>
              {folderNameError(newFolderName.trim())}
            </div>
          )}
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
            创建于当前目录{prefix ? `（${prefix}/）` : '（根目录）'}；虚拟文件夹在转存第一个文件后即真实存在。
          </div>
        </div>
      </Modal>

      {/* 功能引导（首次进入自动弹出，工具行「介绍」可重开） */}
      <VaultGuideModal open={guideOpen} onClose={closeGuide} />
    </div>
  )
}
