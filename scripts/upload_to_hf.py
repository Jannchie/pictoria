from huggingface_hub import HfApi

api = HfApi()
api.upload_large_folder(
    folder_path="server/illustration",
    repo_id="Jannchie/illustration",
    ignore_patterns="**/.*",
    repo_type="dataset",
)
