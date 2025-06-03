from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ai.waifu_scorer import get_waifu_scorer
from models import Post, PostWaifuScore
from progress import get_progress
from server.utils import is_image


def waifu_score_all_posts(session: Session) -> None:
    """
    Use Waifu Scorer to tag posts with a rating of 0.
    """
    batch_size = 32
    waifu_scorer = get_waifu_scorer()
    with get_progress() as progress:
        stmt = select(Post).where(Post.waifu_score == None).order_by(Post.id).execution_options(yield_per=batch_size)  # noqa: E711
        total_stmt = select(func.count(Post.id)).where(Post.waifu_score == None)  # noqa: E711
        total_count = session.scalar(total_stmt)
        post_batches = session.scalars(stmt).partitions()
        task = progress.add_task("Waifu Scorer", total=total_count)
        for batch in post_batches:
            try:
                if not batch:
                    break
                posts = [post for post in batch if is_image(post.absolute_path)]
                images = [post.absolute_path for post in posts]
                if not images:
                    continue
                results = waifu_scorer(images)
                for post, result in zip(posts, results, strict=True):
                    post.waifu_score = PostWaifuScore(post_id=post.id, score=result)
                    session.add(post)
                session.flush()
                progress.update(task, advance=len(posts))
            except Exception as e:
                progress.console.log(f"Error processing batch: {e!s}")
                continue
        session.commit()
