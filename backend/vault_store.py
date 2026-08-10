"""
文件柜存储层（V1.1.3 Dev Vault）— 管理员私人开发文档云柜

设计定稿：tmp/collab/dev-vault/02_kimi.md v5（小克 03 安全评审 + Minimax 04 边界枚举已过）
安全根基：
  - 纯 DB 存储，无文件系统路径概念 → 路径穿越从架构上不存在
  - path 逐段白名单校验（Unicode 字母数字，含中文；显式禁 `..` 段）
  - 敏感文件名检测（.env/私钥类）→ 默认拒绝，需 allow_sensitive 显式确认
  - 同名上传 = 覆盖（碳碳定的语义，与本地改文件一致）
"""
import logging
import re
from datetime import datetime
from fnmatch import fnmatch

from sqlalchemy import DateTime, Integer, String, Text, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session

logger = logging.getLogger(__name__)


class VaultFile(Base):
    """文件柜条目：path 为完整逻辑路径（如 stellaris/CONTEXT.md），文件夹由前缀隐含"""
    __tablename__ = "vault_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(String(255), unique=True)
    content: Mapped[str] = mapped_column(Text)
    # 扩展位：当前恒为管理员 uid；未来开放给用户时按 uid 隔离（只留列不写逻辑）
    owner_uid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(),
                                                 onupdate=func.now())


# ── path 校验（小克 03 清单 2：split 逐段 + 显式禁 .. 双保险）──
_MAX_DEPTH = 5
_MAX_PATH = 255


# ── 时间序列化（踩坑 14：naive UTC 必须补 'Z'，否则前端按本地时区误读差 8 小时）──
def _iso(dt) -> str | None:
    return dt.isoformat() + "Z" if dt else None


class VaultError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


# 黑名单制（V1.2.0 起，碳碳定）：纯 DB 键不接触文件系统，只有分隔符/.. 段/不可见字符是真高危。
# 中文括号、逗号、空格、圆括号、书名号等全部放行。
_CTRL_ZW_RE = re.compile(r"[\x00-\x1f\x7f\u200b-\u200d\ufeff]")


def validate_path(path: str) -> str:
    """校验并返回规整后的 path（去首尾空白/斜杠、剥控制与零宽字符）。不合法抛 VaultError。"""
    p = (path or "").strip().strip("/")
    p = _CTRL_ZW_RE.sub("", p)
    if not p or len(p) > _MAX_PATH:
        raise VaultError("路径为空或超长（≤255 字符）")
    segs = p.split("/")
    if len(segs) > _MAX_DEPTH:
        raise VaultError(f"文件夹层级最多 {_MAX_DEPTH} 层")
    for seg in segs:
        s = seg.strip()
        if not s:
            raise VaultError("存在空的路径段")
        if len(s) > 64:
            raise VaultError("路径段超长（≤64 字符）")
        if s == "..":
            raise VaultError("路径段不允许为 ..")
        if "\\" in s:
            raise VaultError("路径段不允许含反斜杠")
    return "/".join(seg.strip() for seg in segs)


# ── 敏感文件名检测（碳碳方案：检测 + 二次确认，非硬黑名单）──
_SENSITIVE_EXACT = {".env", ".envrc"}   # .envrc = direnv 配置，可能含密钥（小克 07 棒补充）
_SENSITIVE_PATTERNS = (".env.*", "*.pem", "*.key", "id_rsa*")
_SENSITIVE_ALLOW = {".env.example", ".env.sample", ".env.template"}   # 模板放行


def is_sensitive_name(path: str) -> bool:
    """按最后一段文件名判断是否为敏感文件（私钥/真实环境变量等）"""
    name = path.rsplit("/", 1)[-1].lower()
    if name in _SENSITIVE_ALLOW:
        return False
    if name in _SENSITIVE_EXACT:
        return True
    return any(fnmatch(name, pat) for pat in _SENSITIVE_PATTERNS)


# ── CRUD ──

async def list_prefix(prefix: str = "") -> dict:
    """按前缀列出直属子文件夹与文件（不返 content）。prefix 为空 = 根目录"""
    prefix = (prefix or "").strip().strip("/")
    if prefix:
        validate_path(prefix)   # 前缀同样过白名单
        prefix += "/"
    async with async_session() as session:
        rows = (await session.execute(
            select(VaultFile.path, VaultFile.content, VaultFile.updated_at)
            .where(VaultFile.path.startswith(prefix))
        )).all()
    folders, files = set(), []
    for path, content, updated_at in rows:
        rest = path[len(prefix):]
        if "/" in rest:
            folders.add(rest.split("/", 1)[0])
        else:
            files.append({
                "name": rest,
                "path": path,
                "size": len(content.encode("utf-8")),   # UTF-8 字节数（Minimax 04 决策）
                "updated_at": _iso(updated_at),
            })
    files.sort(key=lambda f: f["name"])
    # 总占用（全柜统计，碳碳 2026-08-11 要求；CAST BLOB 后 length 才是字节数，text 是字符数）
    from sqlalchemy import LargeBinary
    async with async_session() as session:
        total_files, total_bytes = (await session.execute(
            select(func.count(), func.coalesce(
                func.sum(func.length(func.cast(VaultFile.content, LargeBinary))), 0))
        )).one()
    return {"prefix": prefix.rstrip("/"), "folders": sorted(folders), "files": files,
            "total": {"files": total_files, "used_bytes": total_bytes}}


async def get_file(path: str) -> dict:
    """读取全文。不存在 → VaultError(404)"""
    p = validate_path(path)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultFile).where(VaultFile.path == p)
        )).scalar_one_or_none()
    if not row:
        raise VaultError("文件不存在", 404)
    return {
        "path": row.path,
        "content": row.content,
        "size": len(row.content.encode("utf-8")),
        "updated_at": _iso(row.updated_at),
    }


async def upsert_file(path: str, content: str, owner_uid: int | None,
                      allow_sensitive: bool = False, via: str = "admin") -> dict:
    """上传/覆盖（碳碳语义：同名即覆盖）。敏感名未确认 → 422；超大 → 413。
    via 标记调用通道（admin/token），token 为最高权限通道，日志须可区分（小克 07 棒）"""
    p = validate_path(path)
    raw = content.encode("utf-8", errors="strict")   # 先能 encode 即合法 Unicode
    if len(raw) > 1024 * 1024:
        raise VaultError("文件超过 1MB 上限", 413)
    if not allow_sensitive and is_sensitive_name(p):
        raise VaultError("检测到敏感文件名，需确认后上传", 422)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultFile).where(VaultFile.path == p)
        )).scalar_one_or_none()
        if row:
            row.content = content
            logger.info("[Vault] 覆盖上传(%s): %s (%d B)", via, p, len(raw))
        else:
            # 并发双新建筑 UNIQUE：回滚后重读（踩坑 19 模式；upsert 语义下到者覆盖）
            try:
                async with session.begin_nested():
                    row = VaultFile(path=p, content=content, owner_uid=owner_uid)
                    session.add(row)
                    await session.flush()
            except IntegrityError:
                row = (await session.execute(
                    select(VaultFile).where(VaultFile.path == p)
                )).scalar_one_or_none()   # 极端并发双方回滚→None（小克 07 棒 nit）
                if row is None:
                    row = VaultFile(path=p, content=content, owner_uid=owner_uid)
                    session.add(row)
                else:
                    row.content = content
            logger.info("[Vault] 新上传(%s): %s (%d B)", via, p, len(raw))
        await session.commit()
        return {"path": p, "size": len(raw)}


async def rename_file(from_path: str, to_path: str, owner_uid: int | None) -> dict:
    """重命名/移动。from 不存在 404；to 已存在 409；并发撞 UNIQUE → 409（踩坑 19）"""
    src = validate_path(from_path)
    dst = validate_path(to_path)
    if is_sensitive_name(dst):
        # rename 到敏感名等效于创建敏感文件，同样要确认——但 rename 无 flag 通道，直接拒
        raise VaultError("目标名称为敏感文件名，不支持", 422)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultFile).where(VaultFile.path == src)
        )).scalar_one_or_none()
        if not row:
            raise VaultError("源文件不存在", 404)
        exists = (await session.execute(
            select(VaultFile.id).where(VaultFile.path == dst)
        )).scalar_one_or_none()
        if exists:
            raise VaultError("目标路径已存在同名文件", 409)
        try:
            row.path = dst
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise VaultError("目标路径已存在同名文件", 409)
    logger.info("[Vault] 重命名: %s → %s", src, dst)
    return {"path": dst}


async def delete_path(path: str) -> None:
    """删单文件，不存在幂等（Minimax 04 决策：幂等 204）"""
    p = validate_path(path)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultFile).where(VaultFile.path == p)
        )).scalar_one_or_none()
        if row:
            await session.delete(row)
            await session.commit()
            logger.info("[Vault] 删除文件: %s", p)


async def delete_prefix(prefix: str) -> int:
    """删文件夹（前缀下全部文件），返回删除数。不存在幂等"""
    p = validate_path(prefix)
    async with async_session() as session:
        rows = (await session.execute(
            select(VaultFile).where(VaultFile.path.startswith(p + "/"))
        )).scalars().all()
        for row in rows:
            await session.delete(row)
        await session.commit()
    if rows:
        logger.info("[Vault] 删除文件夹: %s/（%d 个文件）", p, len(rows))
    return len(rows)


# ── 专用密码（三通道认证之 UI 第二道锁；bcrypt 落库 users.vault_pass_hash）──
from auth.models import User                      # noqa: E402
from auth.utils import (                          # noqa: E402
    hash_password, verify_password, validate_password_strength,
)
import asyncio                                    # noqa: E402


async def vault_password_set(uid: int) -> bool:
    """专用密码是否已设置（进 Tab 判断弹"设置"还是"输入"）"""
    async with async_session() as session:
        user = (await session.execute(
            select(User.vault_pass_hash).where(User.uid == uid)
        )).scalar_one_or_none()
    return bool(user)


async def set_vault_password(uid: int, new_password: str) -> None:
    """设置/修改专用密码（强度复用注册规则；调用方须已过 admin PIN）"""
    errors = validate_password_strength(new_password or "")
    if errors:
        raise VaultError("密码强度不足：" + "；".join(errors))
    hashed = await asyncio.to_thread(hash_password, new_password)
    async with async_session() as session:
        user = (await session.execute(
            select(User).where(User.uid == uid)
        )).scalar_one_or_none()
        if not user:
            raise VaultError("用户不存在", 404)
        user.vault_pass_hash = hashed
        await session.commit()
    logger.info("[Vault] 专用密码已设置/修改 (uid=%s)", uid)


async def verify_vault_password(uid: int, password: str) -> None:
    """逐次校验专用密码。未设 409 / 错误 401。不锁账号（30/min 限流 + bcrypt 200ms 天然减速）"""
    async with async_session() as session:
        hashed = (await session.execute(
            select(User.vault_pass_hash).where(User.uid == uid)
        )).scalar_one_or_none()
    if not hashed:
        raise VaultError("请先设置文件柜专用密码", 409)
    ok = await asyncio.to_thread(verify_password, password or "", hashed)
    if not ok:
        raise VaultError("文件柜密码错误", 401)


# ══════════════════════════════════════════════════════════════
# 用户版文件柜（V1.2.0 内测开放）— 与管理员版物理隔离
# 设计定稿：tmp/collab/vault-user-beta/05_kimi.md
# 铁律（小克 03 棒）：用户域每个 DB 查询 WHERE 必带 owner_uid，没有例外
# ══════════════════════════════════════════════════════════════

from sqlalchemy import UniqueConstraint  # noqa: E402

_USER_SINGLE_FILE_MAX = 1024 * 1024     # 单文件 1MB（与管理员版一致）
_USER_HARD_OVER_MB = 5                  # 满额才拒的硬上限：quota + 5MB
_STORE_LOCKS: dict[int, "asyncio.Lock"] = {}   # 按 uid 串行化转存（防并发超配额）


class VaultUserFile(Base):
    """用户文件柜条目（owner_uid 非空；与管理员 vault_files 物理分表）"""
    __tablename__ = "vault_user_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    owner_uid: Mapped[int] = mapped_column(Integer, index=True)
    path: Mapped[str] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(),
                                                 onupdate=func.now())
    __table_args__ = (UniqueConstraint("owner_uid", "path", name="uq_user_vault"),)


async def user_used_bytes(uid: int) -> tuple[int, int]:
    """(已用字节数, 文件数)。实时 SUM（CAST BLOB 才是字节；定稿 §三.9：量小准确优先）"""
    from sqlalchemy import LargeBinary
    async with async_session() as session:
        used, count = (await session.execute(
            select(
                func.coalesce(func.sum(func.length(func.cast(VaultUserFile.content, LargeBinary))), 0),
                func.count(),
            ).where(VaultUserFile.owner_uid == uid)
        )).one()
    return used, count


async def user_list(uid: int, prefix: str = "") -> dict:
    """列目录（强制 owner 过滤）+ 配额信息"""
    prefix = (prefix or "").strip().strip("/")
    if prefix:
        validate_path(prefix)
        prefix += "/"
    async with async_session() as session:
        rows = (await session.execute(
            select(VaultUserFile.path, VaultUserFile.content, VaultUserFile.updated_at)
            .where(VaultUserFile.owner_uid == uid,
                   VaultUserFile.path.startswith(prefix))
        )).all()
    folders, files = set(), []
    for path, content, updated_at in rows:
        rest = path[len(prefix):]
        if "/" in rest:
            folders.add(rest.split("/", 1)[0])
        else:
            files.append({
                "name": rest, "path": path,
                "size": len(content.encode("utf-8")),
                "updated_at": _iso(updated_at),
            })
    files.sort(key=lambda f: f["name"])
    used, count = await user_used_bytes(uid)
    return {"prefix": prefix.rstrip("/"), "folders": sorted(folders), "files": files,
            "total": {"files": count, "used_bytes": used}}


async def user_get(uid: int, path: str) -> dict:
    """读全文（path + owner 双条件，缺一不可）"""
    p = validate_path(path)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultUserFile).where(VaultUserFile.owner_uid == uid,
                                        VaultUserFile.path == p)
        )).scalar_one_or_none()
    if not row:
        raise VaultError("文件不存在", 404)
    return {"path": row.path, "content": row.content,
            "size": len(row.content.encode("utf-8")), "updated_at": _iso(row.updated_at)}


def _next_available_path(rows: list[str], want: str) -> str:
    """同名追加 -2/-3…：扫已有同前缀名取最大序号 +1（后缀用连字符而非括号——
    括号不在 path 白名单里，挂上去文件自己都不合法，测试实抓）"""
    existing = set(rows)
    if want not in existing:
        return want
    stem, dot, ext = want.rpartition(".")
    base = stem if dot else want
    suffix = dot + ext if dot else ""
    n = 2
    while f"{base}-{n}{suffix}" in existing:
        n += 1
    return f"{base}-{n}{suffix}"


async def user_put(uid: int, path: str, content: str, quota_mb: int) -> dict:
    """用户版写入（转存/内部用）：配额 check（满额才拒 + 硬上限 + 单文件 1MB）+ 撞名自动 (2)"""
    p = validate_path(path)
    raw = content.encode("utf-8", errors="strict")
    size = len(raw)
    if size > _USER_SINGLE_FILE_MAX:
        raise VaultError("单文件超过 1MB 上限", 413)
    used, _ = await user_used_bytes(uid)
    quota_b = quota_mb * 1024 * 1024
    hard_b = quota_b + _USER_HARD_OVER_MB * 1024 * 1024
    if used >= quota_b:
        raise VaultError(f"文件柜已满（当前用量 {used/1024/1024:.2f} MB / 配额 {quota_mb} MB），请先删除文件腾出空间", 409)
    if used + size > hard_b:
        raise VaultError(f"存入后将超出保留上限，请先删除文件腾出空间（当前 {used/1024/1024:.2f} MB / 配额 {quota_mb} MB）", 409)
    async with async_session() as session:
        rows = (await session.execute(
            select(VaultUserFile.path).where(VaultUserFile.owner_uid == uid)
        )).scalars().all()
        final = _next_available_path(list(rows), p)
        try:
            async with session.begin_nested():
                session.add(VaultUserFile(owner_uid=uid, path=final, content=content))
                await session.flush()
        except IntegrityError:   # 极端并发双新建撞 UNIQUE：换个名字再来（定稿 §二.7）
            final = _next_available_path(list(rows) + [final], p)
            session.add(VaultUserFile(owner_uid=uid, path=final, content=content))
        await session.commit()
    logger.info("[Vault] 用户转存: uid=%s %s (%d B)", uid, final, size)
    return {"path": final, "size": size}


async def user_rename(uid: int, from_path: str, to_path: str) -> dict:
    """重命名/移动（owner 过滤；to 已存在 409；敏感名校验不需要——内容全是本站产物）"""
    src = validate_path(from_path)
    dst = validate_path(to_path)
    async with async_session() as session:
        row = (await session.execute(
            select(VaultUserFile).where(VaultUserFile.owner_uid == uid,
                                        VaultUserFile.path == src)
        )).scalar_one_or_none()
        if not row:
            raise VaultError("源文件不存在", 404)
        exists = (await session.execute(
            select(VaultUserFile.id).where(VaultUserFile.owner_uid == uid,
                                           VaultUserFile.path == dst)
        )).scalar_one_or_none()
        if exists:
            raise VaultError("目标路径已存在同名文件", 409)
        try:
            row.path = dst
            await session.commit()
        except IntegrityError:
            await session.rollback()
            raise VaultError("目标路径已存在同名文件", 409)
    logger.info("[Vault] 用户重命名: uid=%s %s → %s", uid, src, dst)
    return {"path": dst}


async def user_delete(uid: int, path: str | None = None, prefix: str | None = None) -> int:
    """删除（owner 过滤，幂等）。prefix 删文件夹"""
    async with async_session() as session:
        if prefix:
            p = validate_path(prefix)
            rows = (await session.execute(
                select(VaultUserFile).where(VaultUserFile.owner_uid == uid,
                                            VaultUserFile.path.startswith(p + "/"))
            )).scalars().all()
        else:
            p = validate_path(path or "")
            rows = (await session.execute(
                select(VaultUserFile).where(VaultUserFile.owner_uid == uid,
                                            VaultUserFile.path == p)
            )).scalars().all()
        for row in rows:
            await session.delete(row)
        await session.commit()
    if rows:
        logger.info("[Vault] 用户删除: uid=%s %s（%d 个）", uid, prefix or path, len(rows))
    return len(rows)


# ── 转存装配（定稿 §四）──

_KIND_SUFFIX = {
    "md": ("笔记.md", "md_content"),
    "summary": ("概要.md", "summary_content"),
    "txt": ("全文.txt", "raw_text"),
    "srt": ("字幕.srt", "subtitle_srt"),
}


def _sanitize_title(title: str) -> str:
    """视频标题 → 合法路径段：只剥分隔符与控制/零宽字符（其余原样保留，
    中文括号/逗号等全保留——V1.2.0 起黑名单制）+ 连续空白压缩 + 截断"""
    t = _CTRL_ZW_RE.sub("", title or "")
    t = t.replace("/", " ").replace("\\", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t[:48]


def _store_lock(uid: int) -> "asyncio.Lock":
    import asyncio as _aio
    if uid not in _STORE_LOCKS:
        _STORE_LOCKS[uid] = _aio.Lock()
    return _STORE_LOCKS[uid]


async def store_from_task(uid: int, task_id: str, kind: str,
                          filename: str | None = None, folder: str | None = None,
                          quota_mb: int = 5) -> dict:
    """从任务产物转存到用户文件柜。校验链顺序（定稿 §四）：
    task 归属（403，先于一切产物读取）→ kind 合法（400）→ 产物非空（404）→ path → 配额 → 写入"""
    from history_store import get_task_record
    task = await get_task_record(task_id)
    if not task or task.get("owner_uid") != uid:
        raise VaultError("任务不存在或不属于你", 403)

    title = task.get("title") or ""
    if kind == "chat":
        # chat 读取必须在 task 归属校验之后（chat_messages 无 owner 列，靠 task 间接保护——铁律）
        from chat_store import get_chat_history
        history = await get_chat_history(task_id)
        if not history:
            raise VaultError("该任务还没有 AI 解读对话", 404)
        safe_title = title.replace("\\", "\\\\").replace("#", "\\#").replace("*", "\\*") or "未命名视频"
        parts = [f"# {safe_title} · AI 解读", ""]
        for m in history:
            if m.get("role") == "user":
                parts.append(f"## Q：{m.get('content', '')}")
            else:
                parts.append(f"A：{m.get('content', '')}")
            parts.append("")
        parts.append("---")
        parts.append(f"来源：Stellaris 提取 · {datetime.now().strftime('%Y-%m-%d')} · {task_id}")
        content = "\n".join(parts)
        suffix = "AI解读.md"
    elif kind in _KIND_SUFFIX:
        suffix, column = _KIND_SUFFIX[kind]
        content = task.get(column)
        if not content:
            raise VaultError("该任务还没有生成此类产物", 404)
    else:
        raise VaultError("不支持的转存类型", 400)

    clean = _sanitize_title(title) or f"未命名-{task_id.replace('stellaris-', '')[:8]}"
    fname = validate_path(filename) if filename else f"{clean}-{suffix}"
    # 用户自定义 filename 也要能加上种类语义：直接用用户输入（已过白名单）
    full = f"{validate_path(folder)}/{fname}" if folder else fname
    full = validate_path(full)   # folder + filename 拼接后整体过白名单（小克 03 棒）

    async with _store_lock(uid):   # 按 uid 串行化（防并发超配额，踩坑 19 场景）
        return await user_put(uid, full, content, quota_mb)
