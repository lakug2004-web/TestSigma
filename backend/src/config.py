"""Application settings, loaded from environment / a local .env file.

Nothing secret is hard-coded here. The OpenRouter key is required for the
describer to run; the GitHub token is never stored in settings — it arrives
per-request and lives only in memory for the duration of a job.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # OpenRouter (LLM) configuration used by the describer pipeline.
    # NOTE: must be a slug that has live endpoints for your OpenRouter account.
    # Browse valid ids at https://openrouter.ai/models
    openrouter_api_key: str = ""
    openrouter_model: str = "openai/gpt-4o-mini"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    # CORS: the Next.js frontend origin allowed to call this service.
    frontend_origin: str = "http://localhost:3000"

    # Neo4j Aura: the knowledge graph of the analysed repo is written here.
    # All four arrive from the Aura instance dashboard / connection file. If
    # `neo4j_uri` is empty the graph step is skipped (AST/descriptions still run).
    neo4j_uri: str = ""
    neo4j_username: str = ""
    neo4j_password: str = Field(default="", repr=False)
    neo4j_database: str = "neo4j"
    aura_instanceid: str = ""
    aura_instancename: str = ""
    # Where the user is sent to browse the graph they just built.
    neo4j_console_url: str = "https://console.neo4j.io"

    # Bounds to keep a single analysis cheap and quick.
    max_python_files: int = 200
    max_file_bytes: int = 200_000
    llm_concurrency: int = 5

    # How long finished jobs are retained in the in-memory store (seconds).
    job_ttl_seconds: int = 3600

    # Logging verbosity (DEBUG shows raw LLM responses).
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
