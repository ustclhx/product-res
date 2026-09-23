.PHONY: setup api web check contracts

setup:
	uv sync --frozen
	cd web && npm ci

api:
	uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

web:
	cd web && npm run dev

contracts:
	uv run --frozen python scripts/export_contracts.py

check:
	uv run --frozen python scripts/export_contracts.py --check
	uv run --frozen ruff check app tests
	uv run --frozen mypy app
	uv run --frozen pytest
	cd web && npm run lint
	cd web && npm run build
	cd web && npm test
