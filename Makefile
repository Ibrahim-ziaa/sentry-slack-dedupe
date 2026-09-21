PORT ?= 8103
PY := .venv/bin/python

.PHONY: demo install web test dev-api dev-web screenshots docker-demo

demo: install web ## build everything and run the offline demo on http://localhost:$(PORT)
	DEMO_MODE=1 PORT=$(PORT) $(PY) -m sentry_slack.app

install: .venv/.installed
.venv/.installed: pyproject.toml
	python3 -m venv .venv
	.venv/bin/pip install -q -e ".[dev]"
	touch $@

web: web/dist/index.html
web/dist/index.html: web/package.json $(shell find web/src -type f) web/index.html
	cd web && npm install --silent && npm run build

test: install
	.venv/bin/pytest

dev-api: install ## API only, pair with dev-web for hot reload
	DEMO_MODE=1 PORT=$(PORT) $(PY) -m sentry_slack.app

dev-web:
	cd web && BACKEND_URL=http://127.0.0.1:$(PORT) npm run dev

screenshots: ## needs the demo running
	scripts/screenshots.sh docs/screens http://127.0.0.1:$(PORT)

docker-demo:
	docker compose up --build
