from functools import cache

from minio import Minio

import shared
from db.asyncbridge import in_thread


@cache
def get_s3_client() -> Minio:
    """Get a cached S3 client."""
    return Minio(
        shared.s3_endpoint,
        access_key=shared.s3_access_key,
        secret_key=shared.s3_secret_key,
        secure=True,
    )


@in_thread
def presigned_get_object_from_s3(object_name: str):
    s3_client = get_s3_client()
    return s3_client.presigned_get_object(
        shared.s3_bucket,
        f"{shared.s3_base_dir}/{object_name}",
    )
