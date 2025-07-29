from collections.abc import Sequence

from rich import get_console
from sqlalchemy import func, select

from db import Session
from models import Post, PostHasTag
from progress import get_progress


def get_tag(tag: PostHasTag):
    if not tag.tag_info.group:
        return tag.tag_info.name
    if tag.tag_info.group.name == "character":
        return f"character:{tag.tag_info.name}"
    if tag.tag_info.group.name == "copyright":
        return f"copyright:{tag.tag_info.name}"
    if tag.tag_info.group.name == "artist":
        return f"artist:{tag.tag_info.name}"
    return tag.tag_info.name


def sort_tags(tags: Sequence[PostHasTag]) -> Sequence[PostHasTag]:
    """
    Sort tags by group and name. First is artist, then character, then copyright, then other tags.
    """

    group_order = {
        "artist": 0,
        "character": 1,
        "copyright": 2,
        "other": 3,
    }

    return sorted(
        tags,
        key=lambda tag: (
            group_order.get(tag.tag_info.group.name if tag.tag_info.group else "other", 3),
            tag.tag_info.name,
        ),
    )


def get_period_tag(post: Post) -> str | None:
    """
    Get the period tag for a post.
    """
    if published_at := post.published_at:
        if published_at.year < 2011:  # noqa: PLR2004
            return "period:old"
        if published_at.year < 2014:  # noqa: PLR2004
            return "period:early"
        if published_at.year < 2018:  # noqa: PLR2004
            return "period:mid"
        if published_at.year < 2021:  # noqa: PLR2004
            return "period:recent"
        return "period:newest"
    return None


def get_rating_tag(post: Post) -> str | None:
    """
    Get the rating tag for a post.
    """

    rating_map = {
        1: "rating:general",
        2: "rating:sensitive",
        3: "rating:questionable",
        4: "rating:explicit",
    }
    return rating_map.get(post.rating)


def get_score_tag(post: Post) -> str | None:
    """
    Get the score tag for a post.
    """

    score_map = {
        1: "score:5",
        2: "score:6",
        3: "score:7",
        4: "score:8",
        5: "score:9",
    }
    return score_map.get(post.score)


def output_dataset():
    console = get_console()
    progress = get_progress(console)
    with Session() as session:
        task = progress.add_task("Outputting dataset...", total=session.scalar(select(func.count(Post.id))))
        console.log("Starting to output dataset...")
        stmt = select(Post).execution_options(yield_per=1000)
        with progress:
            for post in session.scalars(stmt):
                sorted_tags = sort_tags(post.tags)
                tags = [get_tag(tag) for tag in sorted_tags]
                if period_tag := get_period_tag(post):
                    tags.insert(0, period_tag)
                if rating_tag := get_rating_tag(post):
                    tags.insert(0, rating_tag)
                if score_tag := get_score_tag(post):
                    tags.insert(0, score_tag)
                console.log(tags)
                progress.update(task, advance=1)


if __name__ == "__main__":
    output_dataset()
