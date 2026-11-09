PROJECT_ID=trustflow-project
IMAGE_NAME=gcr.io/$(PROJECT_ID)/trustflow-project
REGION=us-central1
SERVICE_NAME=trustflow-web

.PHONY: build push deploy down all create-project check

# Local sanity check — run before every commit.
# The migration check is offline, so it costs nothing and needs no credentials;
# `npm run check:migrations -- --live` additionally compares the local filenames
# against the versions the linked Supabase project has recorded.
check:
	npm run check:migrations && npm test && npm run build

# プロジェクト作成（初回のみ手動実行）
create-project:
	gcloud projects create $(PROJECT_ID)

# The VITE_* values are inlined into the bundle at build time and the Dockerfile
# refuses without them — see the comment there for the silent failure this
# prevents. Passed by NAME, so they are forwarded from this shell rather than
# written into the Makefile or read out of a file here. Export them first, e.g.
#   set -a && . ./.env && set +a && make build
# None of the three is a secret; all are served in the bundle to every visitor.
build:
	docker buildx build --platform linux/amd64 --load \
		--build-arg VITE_SUPABASE_URL \
		--build-arg VITE_SUPABASE_ANON_KEY \
		--build-arg VITE_TURNSTILE_SITE_KEY \
		-t $(IMAGE_NAME) .

push:
	docker push $(IMAGE_NAME)

deploy:
	gcloud config set project $(PROJECT_ID)
	gcloud run deploy $(SERVICE_NAME) \
		--image $(IMAGE_NAME) \
		--platform managed \
		--region $(REGION) \
		--allow-unauthenticated

down:
	gcloud config set project $(PROJECT_ID)
	gcloud run services delete $(SERVICE_NAME) \
		--region $(REGION) \
		--platform managed

all: build push deploy
