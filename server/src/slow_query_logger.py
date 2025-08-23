import time
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import Pool

from utils import logger

# 慢查询阈值（毫秒）
SLOW_QUERY_THRESHOLD_MS = 100.0
# 特别慢查询阈值（毫秒）
VERY_SLOW_QUERY_THRESHOLD_MS = 1000.0


class SlowQueryLogger:
    def __init__(self, engine: Engine, threshold_ms: float = SLOW_QUERY_THRESHOLD_MS) -> None:
        self.engine = engine
        self.threshold_ms = threshold_ms
        self._query_start_times: dict[Any, float] = {}
        self._setup_listeners()

    def _setup_listeners(self) -> None:
        """设置 SQLAlchemy 事件监听器"""
        # 监听查询开始事件
        event.listen(self.engine, "before_cursor_execute", self._before_cursor_execute)
        # 监听查询结束事件
        event.listen(self.engine, "after_cursor_execute", self._after_cursor_execute)
        # 监听连接池事件（可选）
        event.listen(Pool, "connect", self._on_connect)
        event.listen(Pool, "checkout", self._on_checkout)

    def _before_cursor_execute(  # noqa: PLR0913
        self,
        conn: Any,  # noqa: ARG002
        cursor: Any,  # noqa: ARG002
        statement: str,  # noqa: ARG002
        parameters: Any,  # noqa: ARG002
        context: Any,
        executemany: bool,  # noqa: ARG002, FBT001
    ) -> None:
        """记录查询开始时间"""
        self._query_start_times[id(context)] = time.time()

    def _after_cursor_execute(  # noqa: PLR0913
        self,
        conn: Any,  # noqa: ARG002
        cursor: Any,  # noqa: ARG002
        statement: str,
        parameters: Any,
        context: Any,
        executemany: bool,  # noqa: ARG002, FBT001
    ) -> None:
        """计算查询执行时间并记录慢查询"""
        context_id = id(context)
        if context_id in self._query_start_times:
            start_time = self._query_start_times.pop(context_id)
            duration_ms = (time.time() - start_time) * 1000

            # 如果查询时间超过阈值，记录为慢查询
            if duration_ms > self.threshold_ms:
                # 格式化 SQL 语句（移除多余空白）
                formatted_statement = " ".join(statement.split())

                # 截断过长的 SQL 语句
                max_sql_length = 1000
                if len(formatted_statement) > max_sql_length:
                    formatted_statement = formatted_statement[:max_sql_length] + "..."

                # 记录慢查询日志
                logger.warning(
                    f"[SLOW QUERY] Duration: {duration_ms:.2f}ms | "
                    f"SQL: {formatted_statement} | "
                    f"Parameters: {parameters if parameters else 'None'}",
                )

                # 如果查询特别慢（超过1秒），使用 error 级别
                if duration_ms > VERY_SLOW_QUERY_THRESHOLD_MS:
                    logger.error(
                        f"[VERY SLOW QUERY] Duration: {duration_ms:.2f}ms | "
                        f"This query took more than 1 second!",
                    )

    def _on_connect(self, dbapi_conn: Any, connection_record: Any) -> None:  # noqa: ARG002
        """连接建立时的回调(可选)"""
        logger.debug("Database connection established")

    def _on_checkout(self, dbapi_conn: Any, connection_record: Any, connection_proxy: Any) -> None:
        """从连接池获取连接时的回调(可选)"""

    def set_threshold(self, threshold_ms: float) -> None:
        """动态设置慢查询阈值"""
        self.threshold_ms = threshold_ms
        logger.info(f"Slow query threshold set to {threshold_ms}ms")


def setup_slow_query_logging(engine: Engine, threshold_ms: float = SLOW_QUERY_THRESHOLD_MS) -> SlowQueryLogger:
    """便捷函数:设置慢查询日志"""
    slow_query_logger = SlowQueryLogger(engine, threshold_ms)
    logger.info(f"Slow query logging enabled with threshold: {threshold_ms}ms")
    return slow_query_logger
