import queue
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from dotenv import load_dotenv
from rich.progress import track
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Post
from processors import rgb_to_lab_skimage
from shared import logger
from tools.colors import get_dominant_color
from utils import get_session

# 线程本地存储，为每个线程创建独立的数据库会话
thread_local = threading.local()

# 用于安全输出进度的队列
progress_queue = queue.Queue()


def get_thread_session():
    """为每个线程获取独立的数据库会话"""
    if not hasattr(thread_local, "session"):
        thread_local.session = get_session()
    return thread_local.session


def process_post(post_id: int):
    """处理单个帖子的函数"""
    session = get_thread_session()
    try:
        return _update_post_dominant_color(session, post_id)
    except Exception as e:
        # 将错误消息放入队列
        progress_queue.put(("error", f"Error processing post {post_id}: {e!s}"))
        # 如果出错，回滚会话
        session.rollback()
        return False


def _update_post_dominant_color(session: Session, post_id: int) -> bool:
    # 获取帖子
    post = session.get(Post, post_id)

    # 确保帖子存在且检查dominant_color
    if post is None:
        return True

    # 检查是否已有dominant_color - 正确处理NumPy数组
    if post.dominant_color is not None and ((isinstance(post.dominant_color, np.ndarray) and post.dominant_color.size > 0) or post.dominant_color):
        return True

    path = f"./demo/{post.absolute_path}"
    dominant_color = get_dominant_color(path)
    lab_color = rgb_to_lab_skimage(dominant_color)

    # 如果lab_color是NumPy数组，可能需要将其转换为可存储的格式
    if isinstance(lab_color, np.ndarray):
        # 转换为列表或字符串，具体取决于你的数据库字段类型
        lab_color_list = lab_color.tolist()
        post.dominant_color = lab_color_list
    else:
        post.dominant_color = lab_color

    session.commit()
    # 将成功消息放入队列
    progress_queue.put(("info", f"Updated post {post.id}"))
    return True


def progress_reporter():
    """从队列中获取进度消息并记录"""
    while True:
        try:
            msg_type, msg = progress_queue.get(timeout=0.1)
            if msg_type == "info":
                logger.info(msg)
            elif msg_type == "error":
                logger.error(msg)
            progress_queue.task_done()
        except queue.Empty:
            # 队列为空时，检查是否应该退出
            if progress_reporter.should_exit:
                break


def main():
    load_dotenv()
    session = get_session()

    # 获取所有帖子的ID
    posts = session.scalars(select(Post)).all()
    post_ids = [post.id for post in posts]

    # 启动进度报告线程
    progress_reporter.should_exit = False
    reporter_thread = threading.Thread(target=progress_reporter)
    reporter_thread.daemon = True
    reporter_thread.start()

    # 使用线程池执行任务
    max_workers = min(8, len(post_ids))  # 限制线程数量
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # 使用rich.progress跟踪进度
        results = list(track(executor.map(process_post, post_ids), total=len(post_ids), description="Processing posts"))

    # 通知进度报告线程退出
    progress_reporter.should_exit = True
    reporter_thread.join(timeout=1.0)

    # 汇总结果
    success_count = sum(bool(r) for r in results)
    logger.info(f"Processed {len(post_ids)} posts, {success_count} succeeded.")


if __name__ == "__main__":
    main()
