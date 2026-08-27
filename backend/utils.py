"""
工具函数 — 清理、监控、ID 生成
"""
import uuid
import re
import shutil
from pathlib import Path

from config import TMP_DIR, MIN_DISK_SPACE_MB

_URL_RE = re.compile(r"https?://\S+", re.I)


def mask_urls(s: str) -> str:
    """URL 脱敏（V1.3.0 Codex 03 棒）：日志/错误/诊断包不携带完整源链接；
    大小写不敏感（HTTPS:// 也覆盖）。"""
    return _URL_RE.sub("[链接已脱敏]", s or "")


def wash_json_urls(obj):
    """递归 URL 脱敏（V1.3.0 Codex 05 棒）：dict（含 key）/list/嵌套结构全形态。
    用于工单 client_events 等用户可控 JSON 入库前的清洗。"""
    if isinstance(obj, dict):
        return {(mask_urls(str(k)) if isinstance(k, str) else k):
                (wash_json_urls(v) if isinstance(v, (dict, list))
                 else mask_urls(v) if isinstance(v, str) else v)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [wash_json_urls(i) if isinstance(i, (dict, list))
                else mask_urls(i) if isinstance(i, str) else i
                for i in obj]
    if isinstance(obj, str):
        return mask_urls(obj)
    return obj


def generate_task_id() -> str:
    """生成唯一任务 ID"""
    return f"stellaris-{uuid.uuid4().hex[:12]}"


def platform_label(url: str | None) -> str:
    """从视频链接推断来源平台名称（结果页展示用；本地上传传 None）"""
    if not url:
        return "本地上传"
    u = url.lower()
    if "bilibili.com" in u or "b23.tv" in u:
        return "哔哩哔哩"
    if "xiaohongshu.com" in u or "xhslink.com" in u:
        return "小红书"
    # 其他平台：展示域名（如 youtube.com）
    import re
    m = re.search(r"https?://(?:www\.)?([^/]+)", u)
    return m.group(1) if m else "视频链接"


def cleanup_temp_files(task_id: str) -> None:
    """清理指定任务的所有临时文件（仅三处合法调用：用户手动删除 / 管线失败 / 分档过期清理）"""
    task_dir = TMP_DIR / task_id
    if task_dir.exists():
        shutil.rmtree(task_dir, ignore_errors=True)


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
