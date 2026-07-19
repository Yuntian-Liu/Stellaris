"""
工具函数 — 清理、监控、ID 生成
"""
import uuid
import shutil
import os
import time
from pathlib import Path

from config import TMP_DIR, MIN_DISK_SPACE_MB


def generate_task_id() -> str:
    """生成唯一任务 ID"""
    return f"stellaris-{uuid.uuid4().hex[:12]}"


def cleanup_temp_files(task_id: str) -> None:
    """清理指定任务的所有临时文件"""
    task_dir = TMP_DIR / task_id
    if task_dir.exists():
        shutil.rmtree(task_dir, ignore_errors=True)


def cleanup_old_tasks(max_age_hours: float = 1.0) -> int:
    """
    扫描 tmp/ 目录，清理超过 max_age_hours 的任务目录（按目录 mtime 判断）。
    用于自动延迟清理：任务完成后保留一段时间供下载，超期自动删除。

    Returns:
        清理的目录数量
    """
    if not TMP_DIR.exists():
        return 0
    max_age_sec = max_age_hours * 3600
    now = time.time()
    cleaned = 0
    for task_dir in TMP_DIR.iterdir():
        if not task_dir.is_dir():
            continue
        try:
            mtime = task_dir.stat().st_mtime
        except OSError:
            continue
        if now - mtime > max_age_sec:
            shutil.rmtree(task_dir, ignore_errors=True)
            cleaned += 1
    return cleaned


def check_disk_space() -> bool:
    """检查磁盘剩余空间是否足够"""
    usage = shutil.disk_usage(TMP_DIR)
    free_mb = usage.free / (1024 * 1024)
    return free_mb >= MIN_DISK_SPACE_MB


def get_task_dir(task_id: str) -> Path:
    """获取（并创建）任务的临时工作目录"""
    task_dir = TMP_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    return task_dir
