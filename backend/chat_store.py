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
    """按时间正序取回某任务的对话记录"""
    async with async_session() as session:
        result = await session.execute(
            select(ChatMessageRecord)
            .where(ChatMessageRecord.task_id == task_id)
            .order_by(ChatMessageRecord.id)
        )
        return [
            {"role": r.role, "content": r.content, "usage": r.usage}
            for r in result.scalars()
        ]


async def delete_chat_messages(task_id: str) -> None:
    """删除某任务的全部对话记录（任务清理时联动调用）"""
    async with async_session() as session:
        await session.execute(
            delete(ChatMessageRecord).where(ChatMessageRecord.task_id == task_id)
        )
        await session.commit()
