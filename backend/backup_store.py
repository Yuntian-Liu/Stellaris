"""
数据库自动备份 — SQLite 在线快照 + 腾讯云 COS 异地上传

为什么不用 cp：SQLite 运行中被直接 cp 可能拷到「写一半」的损坏文件，
必须用 .backup 命令（在线快照 API）才能拿到一致性快照。

触发：main.py lifespan 启动一个 _periodic_backup 协程，每天 04:00（UTC+8）一次。
配置留空（COS_SECRET_ID/KEY 或 BUCKET）则自动跳过 —— 本地开发零负担。
"""
import asyncio
import logging
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from config import (
    DATA_DIR, DATABASE_URL, IS_PROD,
    COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, COS_BACKUP_RETAIN_DAYS,
)

logger = logging.getLogger(__name__)

# 每日备份（秒）；首次启动后先睡一个周期，避免与启动清理抢资源
_BACKUP_INTERVAL = 24 * 3600

BEIJING = timezone(timedelta(hours=8))


def _utc_to_bj(iso_str: str) -> str:
    """COS LastModified(UTC) → 北京时间 'MM-DD HH:MM'"""
    if not iso_str:
        return ""
    try:
        utc_dt = datetime.strptime(iso_str[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        bj_dt = utc_dt.astimezone(BEIJING)
        return bj_dt.strftime("%m-%d %H:%M")
    except (ValueError, IndexError):
        return iso_str[:16].replace("T", " ")

# 上次备份结果（内存追踪，供管理后台查询；进程重启后丢失，不影响自动备份）
_last_backup: dict | None = None


def _cos_enabled() -> bool:
    """COS 配置是否齐全（缺一项则禁用备份，本地开发零负担）"""
    return bool(COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET)


def _db_path() -> Path:
    """从 DATABASE_URL 解析出 sqlite 文件路径"""
    # 形如 sqlite+aiosqlite:///abs/path/stellaris.db
    return Path(DATABASE_URL.split("///")[-1])


def _safe_backup_to(tmp_path: Path) -> bool:
    """用 sqlite3 .backup 命令生成一致性快照（运行时安全）。
    返回 True 成功；False 失败（库文件不存在等）。"""
    src = _db_path()
    if not src.exists():
        logger.warning("[Backup] DB 文件不存在，跳过：%s", src)
        return False
    try:
        # check_same_thread=False：backup 命令在独立连接执行，不与 ORM 引擎冲突
        src_conn = sqlite3.connect(str(src), check_same_thread=False)
        dst_conn = sqlite3.connect(str(tmp_path))
        src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()
        return True
    except Exception as e:
        logger.error("[Backup] 生成快照失败: %s", e)
        return False


def _upload_to_cos(local_path: Path, object_key: str) -> bool:
    """上传快照到腾讯云 COS。用 cos-python-sdk-v5（需在 requirements 加依赖）。
    返回 True 成功。"""
    if not _cos_enabled():
        return False
    try:
        from qcloud_cos import CosConfig, CosS3Client
        config = CosConfig(Region=COS_REGION, SecretId=COS_SECRET_ID,
                           SecretKey=COS_SECRET_KEY, Scheme="https")
        client = CosS3Client(config)
        client.upload_file(Bucket=COS_BUCKET, Key=object_key, LocalFilePath=str(local_path))
        return True
    except Exception as e:
        logger.error("[Backup] 上传 COS 失败: %s", e)
        return False


def _purge_old_backups(retain_days: int) -> int:
    """列出 COS 上所有 stellaris-YYYY-MM-DD.db，删除超过 retain_days 的旧快照。
    当天及保留期内的绝不删。返回删除份数。静默失败不影响主流程。"""
    if not _cos_enabled():
        return 0
    try:
        from qcloud_cos import CosConfig, CosS3Client
        config = CosConfig(Region=COS_REGION, SecretId=COS_SECRET_ID,
                           SecretKey=COS_SECRET_KEY, Scheme="https")
        client = CosS3Client(config)
        # 列出所有备份文件
        resp = client.list_objects(Bucket=COS_BUCKET, Prefix="stellaris-")
        contents = resp.get("Contents", []) or []
        cutoff = (datetime.now(BEIJING) - timedelta(days=retain_days)).date()
        deleted = 0
        for item in contents:
            key = item.get("Key", "")
            # 从 key 解析日期：stellaris-2026-07-24.db → 2026-07-24
            try:
                date_str = key.replace("stellaris-", "").replace(".db", "")
                file_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            except (ValueError, IndexError):
                continue   # 非 stellaris-日期.db 格式的文件,跳过不动
            if file_date < cutoff:
                client.delete_object(Bucket=COS_BUCKET, Key=key)
                deleted += 1
        return deleted
    except Exception as e:
        logger.warning("[Backup] 清理过期快照失败（忽略）: %s", e)
        return 0


async def do_backup(manual: bool = False) -> dict:
    """执行一次完整备份：快照 → 上传 → 清理过期。
    manual=True 表示手动触发（管理后台按钮），False 为定时自动。
    返回 {ok, uploaded, key, msg} 给调用方/手动触发用。"""
    global _last_backup
    # ① 生成带日期的快照（用 to_thread 避免阻塞事件循环）
    now_bj = datetime.now(BEIJING)
    date_str = now_bj.strftime("%Y-%m-%d")
    object_key = f"stellaris-{date_str}.db"
    tmp_path = DATA_DIR / f"_backup_{date_str}.db"

    snapshot_ok = await asyncio.to_thread(_safe_backup_to, tmp_path)
    if not snapshot_ok:
        _last_backup = {"time_iso": now_bj.isoformat(), "ok": False, "uploaded": False,
                         "key": object_key, "msg": "快照生成失败", "manual": manual}
        return _last_backup | {"ok": False, "uploaded": False, "key": object_key, "msg": "快照生成失败"}

    if not _cos_enabled():
        # 本地开发：生成快照后不上传（清理临时文件）
        tmp_path.unlink(missing_ok=True)
        _last_backup = {"time_iso": now_bj.isoformat(), "ok": True, "uploaded": False,
                         "key": object_key, "msg": "快照生成成功（COS 未配置，跳过上传）", "manual": manual}
        return {"ok": True, "uploaded": False, "key": object_key, "msg": "快照生成成功（COS 未配置，跳过上传）"}

    # ② 上传到 COS
    upload_ok = await asyncio.to_thread(_upload_to_cos, tmp_path, object_key)
    tmp_path.unlink(missing_ok=True)   # 上传后立刻删本地临时文件
    if not upload_ok:
        _last_backup = {"time_iso": now_bj.isoformat(), "ok": False, "uploaded": False,
                         "key": object_key, "msg": "COS 上传失败", "manual": manual}
        return {"ok": False, "uploaded": False, "key": object_key, "msg": "COS 上传失败"}

    # ③ 清理过期：列出 COS 上所有 stellaris-*.db，删掉超过保留期的
    #   保留 N 天 = COS 上永远有最近 N 份；当天刚上传的 key 绝不会在清理范围（它最新）
    deleted = await asyncio.to_thread(_purge_old_backups, COS_BACKUP_RETAIN_DAYS)

    logger.info("[Backup] 备份完成：%s → COS %s（清理 %d 份过期）", date_str, object_key, deleted)
    _last_backup = {"time_iso": now_bj.isoformat(), "ok": True, "uploaded": True,
                     "key": object_key, "msg": f"已上传 {object_key}，清理 {deleted} 份过期", "manual": manual}
    return {"ok": True, "uploaded": True, "key": object_key, "msg": f"已上传 {object_key}，清理 {deleted} 份过期"}


async def _periodic_backup():
    """后台定时备份：每 24 小时一次。
    首次启动延迟到下一个北京时间 04:00（与计费重置时刻对齐，低峰期备份）。"""
    # 计算距下一个 04:00 (UTC+8) 的秒数
    now_bj = datetime.now(BEIJING)
    next_4am = now_bj.replace(hour=4, minute=0, second=0, microsecond=0)
    if now_bj >= next_4am:
        next_4am += timedelta(days=1)
    initial_delay = (next_4am - now_bj).total_seconds()
    await asyncio.sleep(initial_delay)

    while True:
        if not _cos_enabled() and not IS_PROD:
            # 本地非生产 + 未配 COS：不备份（避免开发时反复跑）
            pass
        else:
            try:
                await do_backup()
            except Exception as e:
                logger.error("[Backup] 定时备份异常: %s", e)
        await asyncio.sleep(_BACKUP_INTERVAL)


def get_backup_status() -> dict:
    """查询备份状态（供 admin 接口用）：COS 配置、上次结果、保留策略、历史列表"""
    return {
        "cos_enabled": _cos_enabled(),
        "last_backup": _last_backup,
        "retention_days": COS_BACKUP_RETAIN_DAYS,
        "history": _list_backup_objects(),
    }


def _list_backup_objects() -> list[dict]:
    """列出 COS 上所有 stellaris-*.db 备份文件（按时间倒序，供管理后台展示历史）"""
    if not _cos_enabled():
        return []
    try:
        from qcloud_cos import CosConfig, CosS3Client
        config = CosConfig(Region=COS_REGION, SecretId=COS_SECRET_ID,
                           SecretKey=COS_SECRET_KEY, Scheme="https")
        client = CosS3Client(config)
        resp = client.list_objects(Bucket=COS_BUCKET, Prefix="stellaris-")
        items = []
        cutoff = (datetime.now(BEIJING) - timedelta(days=COS_BACKUP_RETAIN_DAYS)).date()
        for obj in resp.get("Contents", []) or []:
            key = obj.get("Key", "")
            try:
                date_str = key.replace("stellaris-", "").replace(".db", "")
                file_date = datetime.strptime(date_str, "%Y-%m-%d").date()
                days_left = (file_date - cutoff).days
            except (ValueError, IndexError):
                continue
            # 判断自动/手动：匹配内存 _last_backup；否则按上传时间是否为凌晨 04:00 附近推断
            mode = "自动"
            if _last_backup and _last_backup.get("key") == key:
                mode = "手动" if _last_backup.get("manual") else "自动"
            else:
                lm = obj.get("LastModified", "")
                if lm:
                    try:
                        # COS 返回格式如 "2026-07-24T06:30:00.000Z"
                        from datetime import timezone as tz_utc
                        utc_time = datetime.strptime(lm[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=tz_utc.utc)
                        bj_hour = (utc_time + timedelta(hours=8)).hour
                        mode = "自动" if 3 <= bj_hour <= 5 else "手动"
                    except (ValueError, IndexError):
                        pass
            items.append({
                "key": key,
                "date": date_str,
                "time": _utc_to_bj(obj.get("LastModified", "")),
                "size_bytes": obj.get("Size", 0),
                "days_until_cleanup": days_left,
                "mode": mode,
            })
        items.sort(key=lambda x: x["date"], reverse=True)
        return items
    except Exception as e:
        logger.warning("[Backup] 列出备份历史失败（忽略）: %s", e)
        return []
