from rich import get_console
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)


def get_progress(console: Console | None = None) -> Progress:
    """Return a Progress object."""
    return Progress(
        SpinnerColumn(style="yellow"),
        TextColumn(" {task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        TaskProgressColumn(),
        console=console or get_console(),
    )
