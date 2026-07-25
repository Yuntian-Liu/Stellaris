"""
AI 对话记录存储 — SQLite 持久化（随任务生命周期清理）

设计：
- 对话存 stellaris.db（已在 Volume 持久化，无需新增目录/环境变量）
- 生命周期跟随任务：手动清理 / 1 小时自动清理时联动删除
- usage 存 JSON（prompt/completion/cache tokens），为计费流水预留
"""
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Integer, String, Text, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session


class ChatMessageRecord(Base):
    """AI 解读对话的单条消息"""
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(String(64), index=True)
    role: Mapped[str] = mapped_column(String(16))          # user | assistant
    content: Mapped[str] = mapped_column(Text)
    usage: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # token 用量
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


async def save_chat_message(
    task_id: str,
    role: str,
    content: str,
    usage: dict | None = None,
) -> None:
    """写入一条对话消息"""
    async with async_session() as session:
        session.add(ChatMessageRecord(
            task_id=task_id, role=role, content=content, usage=usage,
        ))
        await session.commit()


async def get_chat_history(task_id: str) -> list[dict]:
    """按时间正序取回某任务的对话记录。
    charged 不落库，按 usage 用 round_tokens 复算（与 consume_gravity 同一公式，
    全价结算场景恒等；余额不足扣光的极端场景会略有出入，可接受）——
    否则前端刷新/重开后"扣 N 引力波"会丢失（碳碳实测时隐时现的根因）。"""
    from billing_store import round_tokens, GRAVITY_PER_TOKEN_UNIT
    async with async_session() as session:
        result = await session.execute(
            select(ChatMessageRecord)
            .where(ChatMessageRecord.task_id == task_id)
            .order_by(ChatMessageRecord.id)
        )
        out = []
        for r in result.scalars():
            charged = 0
            if r.role == "assistant" and r.usage:
                charged = round_tokens(
                    (r.usage.get("prompt_tokens") or 0) + (r.usage.get("completion_tokens") or 0),
                    GRAVITY_PER_TOKEN_UNIT,
                )
            out.append({"role": r.role, "content": r.content, "usage": r.usage, "charged": charged})
        return out


async def delete_chat_messages(task_id: str) -> None:
    """删除某任务的全部对话记录（任务清理时联动调用）"""
    async with async_session() as session:
        await session.execute(
            delete(ChatMessageRecord).where(ChatMessageRecord.task_id == task_id)
        )
        await session.commit()
