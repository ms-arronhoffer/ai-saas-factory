"""FastAPI application entrypoint.

Exposes /health and /ready for the factory's verify stage, mounts the auth and
items routers, and enables permissive CORS for local development only.
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Base, engine
from .routers import auth, items

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

settings = get_settings()
app = FastAPI(title="SaaS Factory Starter", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    # For the starter slice we create tables on boot so it runs with zero infra.
    # Replace with Alembic migrations before production (see ARCHITECTURE.md).
    Base.metadata.create_all(bind=engine)


@app.get("/health", tags=["ops"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready", tags=["ops"])
def ready() -> dict[str, str]:
    return {"status": "ready"}


app.include_router(auth.router)
app.include_router(items.router)
