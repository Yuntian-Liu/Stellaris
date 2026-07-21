"""
历史记录 — task_records 表（随任务生命周期联动删除）

V1 规则：记录与任务同寿命——任务清理（手动/自动 1 小时）时记录联动删除。
服务器重启后内存态丢失，记录虽在但无法重开（前端按 404 标记已失效并移除）。
会员长时保留后续在此结构上扩展。
"""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session


class TaskRecord(Base):
    """提取历史记录（仅登录用户）"""
    __tablename__ = "task_records"

    task_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_uid: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(256), default="未知视频")
    source_platform: Mapped[str] = mapped_column(String(32), default="")
    status: Mapped[str] = mapped_column(String(16), default="completed")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )


async def save_task_record(task_id: str, owner_uid: int | None,
                           title: str, source_platform: str) -> None:
    """管线完成时写入记录（未登录不记）"""
    if not owner_uid:
        return
    async with async_session() as session:
        await session.merge(TaskRecord(
            task_id=task_id, owner_uid=owner_uid,
            title=(title or "未知视频")[:256], source_platform=source_platform,
        ))
        await session.commit()


async def list_task_records(uid: int) -> list[dict]:
    """按时间倒序取用户历史"""
    async with async_session() as session:
        result = await session.execute(
            select(TaskRecord)
            .where(TaskRecord.owner_uid == uid)
            .order_by(TaskRecord.created_at.desc())
            .limit(50)
        )
        return [
            {
                "task_id": r.task_id,
                "title": r.title,
                "source_platform": r.source_platform,
                # 补 'Z' 按 UTC 序列化：naive 时间会被前端当本地解析，显示差 8 小时
                "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None,
            }
            for r in result.scalars()
        ]


async def delete_task_record(task_id: str) -> None:
    """任务清理时联动删除"""
    async with async_session() as session:
        await session.execute(
            delete(TaskRecord).where(TaskRecord.task_id == task_id)
        )
        await session.commit()


async def get_task_owner_map(task_ids: list[str]) -> dict[str, int]:
    """批量取 task_id → owner_uid（定时清理按归属档位判定保留时长用）"""
    if not task_ids:
        return {}
    async with async_session() as session:
        result = await session.execute(
            select(TaskRecord).where(TaskRecord.task_id.in_(task_ids))
        )
        return {r.task_id: r.owner_uid for r in result.scalars()}


async def get_task_record(task_id: str) -> dict | None:
    """取单条记录（冷启动重建结果页状态用）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return None
        return {"title": r.title, "source_platform": r.source_platform,
                "owner_uid": r.owner_uid}
