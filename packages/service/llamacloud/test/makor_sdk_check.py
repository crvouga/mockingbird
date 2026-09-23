"""
Drive the REAL Makor chat LlamaCloud client (apps/makor-ecosystem/services/chat/app/core/rag/
llamacloud_client.py) and the REAL llama_cloud_services SDK against the mock.

Usage: python makor_sdk_check.py <client.py path> <base_url> <api_key> <index> <project> <query>

The client module imports `app.utils.logging.get_logger`, which pulls the whole Makor settings
stack; a stub logger stands in for it. Everything else (LlamaCloudIndex, as_retriever,
aretrieve, the httpx calls) is the pinned SDK. The mock is selected the way the Makor service
would select it: LLAMA_CLOUD_BASE_URL (the client passes no base_url).
"""

import asyncio
import importlib.util
import json
import sys
import types


class _Logger:
    def _log(self, *args, **kwargs):
        pass

    debug = info = warning = error = exception = _log


def main() -> None:
    client_path, base_url, api_key, index, project, query = sys.argv[1:7]
    import os

    os.environ["LLAMA_CLOUD_BASE_URL"] = base_url
    app = types.ModuleType("app")
    utils = types.ModuleType("app.utils")
    logging_mod = types.ModuleType("app.utils.logging")
    logging_mod.get_logger = lambda name=None: _Logger()
    sys.modules.update({"app": app, "app.utils": utils, "app.utils.logging": logging_mod})

    spec = importlib.util.spec_from_file_location("llamacloud_client", client_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    client = module.LlamaCloudClient(
        index_name=index, api_key=api_key, project_name=project, dense_top_k=3
    )
    result = asyncio.run(client.retrieve(query))
    print(
        json.dumps(
            {
                "error": client._initialization_error,
                "available": client.is_available,
                "total": result.total_retrieved,
                "sources": [
                    {
                        "content": s.content,
                        "score": s.score,
                        "title": s.title,
                        "source_id": s.source_id,
                        "document_id": s.metadata.get("document_id"),
                    }
                    for s in result.sources
                ],
            }
        )
    )


if __name__ == "__main__":
    main()
