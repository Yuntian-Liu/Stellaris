"""
LLM 调用健康（V1.2.2）：llm_call_events 表

每次 LLM 调用记一行（含异常），管理后台「模型」Tab 的「调用健康」区读它——
目标是"用户报问题之前，管理后台先看到"（空回答/截断/拒答不再只躺在日志里）。

清理策略：不清理。一天几百行、一年几万行，SQLite 无感。
（真到量大那天再加时间窗清理，别为不存在的问题写代码）
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, and_, case, func, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session

logger = logging.getLogger(__name__)


class LlmCallEvent(Base):
    """LLM 调用事件（一行 = 一次调用，含失败）"""
    __tablename__ = "llm_call_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    feature: Mapped[str] = mapped_column(String(16))          # segment/md/summary/chat/asr
    model: Mapped[str] = mapped_column(String(64))
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_hit_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_miss_tokens: Mapped[int] = mapped_column(Integer, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(Integer, default=0)
    finish_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)  # stop/length/content_filter/None=异常
    is_empty: Mapped[bool] = mapped_column(Boolean, default=False)   # 正文 0 字符
    task_id: Mapped[str | None] = mapped_column(String(32), nullable=True)


async def record_llm_call(feature: str, model: str, usage: dict | None,
                          finish_reason: str | None, is_empty: bool,
                          task_id: str | None = None) -> None:
    """写一行调用事件。埋点失败绝不阻断主流程（调用方包 try/except，这里再兜一层）"""
    try:
        u = usage or {}
        async with async_session() as session:
            session.add(LlmCallEvent(
                feature=feature, model=model,
                prompt_tokens=u.get("prompt_tokens") or 0,
                completion_tokens=u.get("completion_tokens") or 0,
                cache_hit_tokens=u.get("cache_hit_tokens") or 0,
                cache_miss_tokens=u.get("cache_miss_tokens") or 0,
                reasoning_tokens=u.get("reasoning_tokens") or 0,
                finish_reason=finish_reason, is_empty=is_empty, task_id=task_id,
            ))
            await session.commit()
    except Exception as e:
        logger.warning("[LLM健康] 事件落库失败(不影响主流程): %s", e)


def _since(days: float) -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)


async def get_llm_health() -> dict:
    """管理后台「调用健康」数据源：24h/7d 汇总 + 最近 50 条异常事件

    口径（Codex 08 棒修正）：
    - SUM 必须用 case 转 Integer——SQLite 能算对 Boolean 求和，但 SQLAlchemy 会把结果
      按 Boolean 解码成 True/False（3 条异常显示成 1），这是真实踩过的坑
    - healthy（正常）是互斥口径：finish_reason='stop' 且非空回答；异常 = 总数 - 健康数。
      empty 与 length 有交集（空回答常因 length），不能从 total 里减两个重叠指标
    """
    async with async_session() as session:
        async def window_stats(days: float) -> dict:
            q = await session.execute(
                select(func.count(),
                       func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)),
                       func.sum(case((LlmCallEvent.finish_reason == "length", 1), else_=0)),
                       func.sum(case((and_(LlmCallEvent.finish_reason == "stop",
                                           LlmCallEvent.is_empty.is_(False)), 1), else_=0)))
                .where(LlmCallEvent.created_at >= _since(days))
            )
            total, empty, length, healthy = q.one()
            by_feature = (await session.execute(
                select(LlmCallEvent.feature, func.count(),
                       func.sum(case((LlmCallEvent.is_empty.is_(True), 1), else_=0)))
                .where(LlmCallEvent.created_at >= _since(days))
                .group_by(LlmCallEvent.feature)
            )).all()
            return {
                "total": total or 0,
                "empty": int(empty or 0),
                "length": int(length or 0),
                "healthy": int(healthy or 0),
                "by_feature": {f: {"total": c, "empty": int(e or 0)} for f, c, e in by_feature},
            }

        h24 = await window_stats(1)
        d7 = await window_stats(7)

        # 异常事件：空回答 / finish 非 stop（含异常调用 finish=None）
        abnormal = (await session.execute(
            select(LlmCallEvent)
            .where((LlmCallEvent.is_empty.is_(True))
                   | (LlmCallEvent.finish_reason.is_(None))
                   | (LlmCallEvent.finish_reason != "stop"))
            .order_by(LlmCallEvent.id.desc()).limit(50)
        )).scalars().all()

    def _row(e: LlmCallEvent) -> dict:
        return {
            "id": e.id,
            "ts": e.created_at.isoformat() + "Z" if e.created_at else None,
            "feature": e.feature, "model": e.model,
            "finish_reason": e.finish_reason, "is_empty": e.is_empty,
            "prompt_tokens": e.prompt_tokens, "completion_tokens": e.completion_tokens,
            "reasoning_tokens": e.reasoning_tokens, "task_id": e.task_id,
        }

    return {"h24": h24, "d7": d7, "abnormal": [_row(e) for e in abnormal]}
