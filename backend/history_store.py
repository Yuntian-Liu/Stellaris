"""
历史记录 — task_records 表（随任务生命周期联动删除）

V1 规则：记录与任务同寿命——任务清理（手动/自动 1 小时）时记录联动删除。
服务器重启后内存态丢失，记录虽在但无法重开（前端按 404 标记已失效并移除）。
会员长时保留后续在此结构上扩展。
"""
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text, delete, select
from sqlalchemy.orm import Mapped, mapped_column

from database import Base, async_session
from config import TMP_DIR


class TaskRecord(Base):
    """提取历史记录（仅登录用户）"""
    __tablename__ = "task_records"

    task_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_uid: Mapped[int] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(String(256), default="未知视频")
    source_platform: Mapped[str] = mapped_column(String(32), default="")
    # 源视频链接（V1.3.0：历史记录可回顾跳转；本地上传为 NULL 不显示；完整保存不截断）
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="completed")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    # 任务内容（V0.12.2：从 TMP_DIR 迁移至 DB，COS 备份全覆盖）
    raw_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    subtitle_srt: Mapped[str | None] = mapped_column(Text, nullable=True)
    md_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 统计字段持久化（V1.1.0：原仅存内存，重启即失；档案 DB 优先内存兜底）
    actual_chars: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_seg_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    subtitle_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    md_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    summary_status: Mapped[str | None] = mapped_column(String(16), nullable=True)


async def save_task_runtime(task_id: str, **fields) -> None:
    """按列更新统计字段（V1.1.0；NULL 字段跳过不覆盖，记录不存在则忽略）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return
        for field, value in fields.items():
            if hasattr(r, field) and value is not None:
                setattr(r, field, value)
        await session.commit()


async def save_task_record(task_id: str, owner_uid: int | None,
                           title: str, source_platform: str,
                           source_url: str | None = None) -> None:
    """管线完成时写入记录（未登录不记）。V1.3.0：source_url 源链接（上传为 None）"""
    if not owner_uid:
        return
    async with async_session() as session:
        await session.merge(TaskRecord(
            task_id=task_id, owner_uid=owner_uid,
            title=(title or "未知视频")[:256], source_platform=source_platform,
            source_url=source_url or None,   # 完整保存（静默截断会让冷重载后链接失效）
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
                "source_url": r.source_url,
                "created_at": (r.created_at.isoformat() + "Z") if r.created_at else None,
                "has_content": bool(r.raw_text),
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
    """取单条记录（冷启动重建结果页状态用，含内容字段）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return None
        return {"title": r.title, "source_platform": r.source_platform,
                "owner_uid": r.owner_uid, "source_url": r.source_url,
                "raw_text": r.raw_text, "subtitle_srt": r.subtitle_srt,
                "md_content": r.md_content, "summary_content": r.summary_content}


async def save_task_content(task_id: str, **kwargs) -> None:
    """按列写入任务内容（管线/MD/概要完成后调用）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return
        for field, value in kwargs.items():
            if hasattr(r, field) and value is not None:
                setattr(r, field, str(value))
        await session.commit()


async def get_task_content(task_id: str) -> dict | None:
    """读取全部内容列（下载/结果页用）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return None
        return {
            "raw_text": r.raw_text,
            "subtitle_srt": r.subtitle_srt,
            "md_content": r.md_content,
            "summary_content": r.summary_content,
        }


async def nullify_task_content(task_id: str) -> None:
    """过期清理：置 NULL 内容列，保留元数据（标题/时间）"""
    async with async_session() as session:
        r = await session.get(TaskRecord, task_id)
        if not r:
            return
        r.raw_text = None
        r.subtitle_srt = None
        r.md_content = None
        r.summary_content = None
        r.source_url = None   # V1.3.0：源链接与任务数据同周期清理（协议承诺）
        await session.commit()


async def migrate_files_to_db() -> int:
    """一次性启动迁移：扫描 TMP_DIR 存量文件写入 DB。
    幂等——已写过（raw_text 不为 NULL）的任务跳过。
    返回成功迁移的任务数。"""
    if not TMP_DIR.exists():
        return 0

    migrated = 0
    for task_dir in TMP_DIR.iterdir():
        if not task_dir.is_dir():
            continue
        task_id = task_dir.name

        async with async_session() as session:
            r = await session.get(TaskRecord, task_id)
            if not r:
                continue
            if r.raw_text:
                continue  # 已迁移，跳过

            updated = False
            for file_name, col_name in [
                ("output.txt", "raw_text"),
                ("output.srt", "subtitle_srt"),
                ("output.md", "md_content"),
                ("output_summary.md", "summary_content"),
            ]:
                file_path = task_dir / file_name
                if file_path.exists():
                    try:
                        content = file_path.read_text(encoding="utf-8")
                        setattr(r, col_name, content)
                        updated = True
                    except OSError:
                        pass

            if updated:
                await session.commit()
                migrated += 1

    if migrated:
        import logging
        logging.getLogger(__name__).info("[Migrate] 已将 %d 个任务的内容从文件迁移到数据库", migrated)
    return migrated
