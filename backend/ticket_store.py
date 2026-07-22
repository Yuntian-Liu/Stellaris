"""
反馈工单 — support_tickets 表

用户侧：提交 Bug 反馈 / 功能建议（可附诊断日志），查看自己的工单与管理员回复。
管理员侧：查看全部工单、回复、关闭、重新打开（状态机校验 + PIN 二次验证在路由层）。

状态流转（TRANSITIONS）：
    pending → processing → replied → (reply/reply_close/reopen)
                              ↘ closed → reopen → processing

未读判定：replied_at 非空 且 (user_read_at 为空 或 replied_at > user_read_at)
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import DateTime, Integer, String, Boolean, select
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from database import Base, async_session
from billing_store import _utcnow, _iso_utc
from config import DATA_DIR

logger = logging.getLogger(__name__)


class SupportTicket(Base):
    """用户反馈工单"""
    __tablename__ = "support_tickets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_uid: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(16))          # bug/suggestion/other
    description: Mapped[str] = mapped_column(String(4000))     # 详细描述
    occur_at: Mapped[str | None] = mapped_column(String(32), nullable=True)     # Bug: 问题发生时间
    repro_steps: Mapped[str | None] = mapped_column(String(32), nullable=True)  # Bug: 复现次数
    contact: Mapped[str | None] = mapped_column(String(128), nullable=True)     # 选填联系方式
    log_path: Mapped[str | None] = mapped_column(String(256), nullable=True)    # 日志文件相对路径（无则 None）
    status: Mapped[str] = mapped_column(String(16), default="pending")          # pending/processing/replied/closed
    admin_reply: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)   # 管理员最近回复时间
    user_read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True) # 用户最近查看时间
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


# ===== 状态机合法跳转表（防接口裸调绕过前端按钮隐藏）=====
# action → 目标状态
TRANSITIONS = {
    "pending":    {"start": "processing"},
    "processing": {"reply": "replied", "reply_close": "closed", "close": "closed"},
    "replied":    {"reply": "replied", "reply_close": "closed", "reopen": "processing"},
    "closed":     {"reopen": "processing"},
}


class TicketError(Exception):
    """工单业务异常（详情走 detail）"""
    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


def _validate_transition(current_status: str, action: str) -> str:
    """返回新状态；非法跳转 raise TicketError"""
    allowed = TRANSITIONS.get(current_status, {})
    if action not in allowed:
        raise TicketError(f"工单当前状态（{current_status}）不允许该操作（{action}）")
    return allowed[action]


def _ticket_to_dict(t: SupportTicket, *, unread: bool | None = None) -> dict:
    """ORM → dict；unread 仅列表场景计算传入"""
    return {
        "id": t.id,
        "user_uid": t.user_uid,
        "title": t.title,
        "category": t.category,
        "description": t.description,
        "occur_at": t.occur_at,
        "repro_steps": t.repro_steps,
        "contact": t.contact,
        "has_log": bool(t.log_path),
        "status": t.status,
        "admin_reply": t.admin_reply,
        "replied_at": _iso_utc(t.replied_at),
        "user_read_at": _iso_utc(t.user_read_at),
        "created_at": _iso_utc(t.created_at),
        "updated_at": _iso_utc(t.updated_at),
        **({"unread": unread} if unread is not None else {}),
    }


async def create_ticket(uid: int, *, title: str, category: str, description: str,
                        occur_at: str | None = None, repro_steps: str | None = None,
                        contact: str | None = None) -> dict:
    """落库（log_path 留空，由路由层抓完日志后 update_ticket_log_path 回填）"""
    async with async_session() as session:
        t = SupportTicket(
            user_uid=uid, title=title[:200], category=category,
            description=description[:4000], occur_at=occur_at,
            repro_steps=repro_steps, contact=contact,
            status="pending",
        )
        session.add(t)
        await session.commit()
        await session.refresh(t)
        return _ticket_to_dict(t)


async def update_ticket_log_path(tid: int, log_path: str) -> None:
    """路由层抓完诊断日志后回填路径"""
    async with async_session() as session:
        t = await session.get(SupportTicket, tid)
        if t:
            t.log_path = log_path
            await session.commit()


async def list_user_tickets(uid: int) -> list[dict]:
    """用户的工单列表（时间倒序），含 unread 标记"""
    async with async_session() as session:
        result = await session.execute(
            select(SupportTicket)
            .where(SupportTicket.user_uid == uid)
            .order_by(SupportTicket.created_at.desc())
        )
        items = []
        for t in result.scalars():
            unread = bool(t.replied_at) and (not t.user_read_at or t.replied_at > t.user_read_at)
            items.append(_ticket_to_dict(t, unread=unread))
        return items


async def list_all_tickets(status: str | None = None) -> list[dict]:
    """管理员：全部工单（可选状态筛选）"""
    async with async_session() as session:
        q = select(SupportTicket).order_by(SupportTicket.created_at.desc())
        if status:
            q = q.where(SupportTicket.status == status)
        result = await session.execute(q)
        return [_ticket_to_dict(t) for t in result.scalars()]


async def get_ticket_for_user(tid: int, uid: int) -> dict | None:
    """用户取单条（owner 校验：非本人返回 None）"""
    async with async_session() as session:
        t = await session.get(SupportTicket, tid)
        if not t or t.user_uid != uid:
            return None
        return _ticket_to_dict(t)


async def get_ticket_admin(tid: int) -> dict | None:
    """管理员取单条（不做 owner 校验，含 log_path 字段供读取日志）"""
    async with async_session() as session:
        t = await session.get(SupportTicket, tid)
        if not t:
            return None
        d = _ticket_to_dict(t)
        d["log_path"] = t.log_path   # 管理员需要原始路径来读日志文件
        return d


async def mark_user_read(tid: int, uid: int) -> None:
    """用户点开详情 → 写 user_read_at（仅 owner；消未读红点）"""
    async with async_session() as session:
        t = await session.get(SupportTicket, tid)
        if t and t.user_uid == uid:
            t.user_read_at = _utcnow()
            await session.commit()


async def reply_ticket(tid: int, action: str, reply: str | None) -> dict:
    """管理员操作（状态机校验）：
    - start: pending → processing（不回复）
    - reply / reply_close: 写 admin_reply + replied_at
    - close: processing/replied → closed（不回复，极少数场景）
    - reopen: closed → processing"""
    async with async_session() as session:
        t = await session.get(SupportTicket, tid)
        if not t:
            raise TicketError("工单不存在")
        new_status = _validate_transition(t.status, action)
        # 回复类动作必须有内容（close/start/reopen 不要求）
        if action in ("reply", "reply_close"):
            if not reply or not reply.strip():
                raise TicketError("回复内容不能为空")
            t.admin_reply = reply.strip()[:2000]
            t.replied_at = _utcnow()
        t.status = new_status
        await session.commit()
        await session.refresh(t)
        return _ticket_to_dict(t)


def write_log_file(tid: int, diag: dict) -> str:
    """落诊断日志到磁盘，返回相对路径（相对 DATA_DIR）"""
    log_dir = DATA_DIR / "tickets" / str(tid)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "diagnostic.json"
    log_file.write_text(json.dumps(diag, ensure_ascii=False, indent=2), encoding="utf-8")
    return f"tickets/{tid}/diagnostic.json"


def read_log_content(log_path: str | None) -> str | None:
    """管理员查看：读日志文件内容"""
    if not log_path:
        return None
    try:
        return (DATA_DIR / log_path).read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("[Ticket] 读取日志失败 %s: %s", log_path, e)
        return None
