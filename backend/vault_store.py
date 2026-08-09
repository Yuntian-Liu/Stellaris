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
_SEGMENT_RE = re.compile(r"^[\w.-]{1,64}$")   # Python \w 含中文等 Unicode 字母数字
_MAX_DEPTH = 5
_MAX_PATH = 255


class VaultError(Exception):
    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def validate_path(path: str) -> str:
    """校验并返回规整后的 path（去首尾空白/斜杠）。不合法抛 VaultError。"""
    p = (path or "").strip().strip("/")
    if not p or len(p) > _MAX_PATH:
        raise VaultError("路径为空或超长（≤255 字符）")
    segs = p.split("/")
    if len(segs) > _MAX_DEPTH:
        raise VaultError(f"文件夹层级最多 {_MAX_DEPTH} 层")
    for seg in segs:
        if seg == "..":
            raise VaultError("路径段不允许为 ..")
        if not _SEGMENT_RE.match(seg):
            raise VaultError(f"路径段含非法字符：{seg!r}（仅允许中英文/数字/._-）")
    return p


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
                "updated_at": updated_at.isoformat() if updated_at else None,
            })
    files.sort(key=lambda f: f["name"])
    return {"prefix": prefix.rstrip("/"), "folders": sorted(folders), "files": files}


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
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
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
