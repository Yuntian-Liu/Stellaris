"""
用户数据统计 — user_stats 表 + 累加/查询

设计：
- 独立新表（不动 users 表，create_all 自动建，线上零迁移风险）
- 计数器永久保留，与任务 1 小时清理无关（呈现"成就感总结"只需计数）
- 未登录使用不计入（任务无归属）
"""
from sqlalchemy import Integer, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session


class UserStats(Base):
    """用户累计统计（成就感数字，只增不减）"""
    __tablename__ = "user_stats"

    user_uid: Mapped[int] = mapped_column(Integer, primary_key=True)
    videos_extracted: Mapped[int] = mapped_column(Integer, default=0)   # 提取视频数
    chars_transcribed: Mapped[int] = mapped_column(Integer, default=0)  # 累计转写字数
    md_notes: Mapped[int] = mapped_column(Integer, default=0)           # MD 笔记数
    chat_rounds: Mapped[int] = mapped_column(Integer, default=0)        # AI 解读轮数
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)        # 累计 tokens


async def incr_stats(user_uid: int, **fields: int) -> None:
    """累加计数（upsert：无记录先建行）。fields 为列名=增量"""
    if not fields:
        return
    async with async_session() as session:
        row = await session.get(UserStats, user_uid)
        if row is None:
            row = UserStats(user_uid=user_uid)
            session.add(row)
        for key, delta in fields.items():
            if hasattr(row, key) and isinstance(delta, int):
                setattr(row, key, (getattr(row, key) or 0) + delta)
        await session.commit()


async def get_stats(user_uid: int) -> dict:
    """查询计数（无记录返回全零）"""
    async with async_session() as session:
        row = await session.get(UserStats, user_uid)
        if row is None:
            return {
                "videos_extracted": 0, "chars_transcribed": 0,
                "md_notes": 0, "chat_rounds": 0, "tokens_used": 0,
            }
        return {
            "videos_extracted": row.videos_extracted,
            "chars_transcribed": row.chars_transcribed,
            "md_notes": row.md_notes,
            "chat_rounds": row.chat_rounds,
            "tokens_used": row.tokens_used,
        }
