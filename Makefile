# Local checks and a local container image. NOT a deploy path.
#
# WHAT HAPPENED TO THE DEPLOY TARGETS
# This file used to carry `deploy`, `down`, `push`, `create-project` and
# `all: build push deploy`, all aimed at Cloud Run in the GCP project
# `trustflow-project`. That is not how TrustFlow ships and has not been for a
# long time, so every one of them was removed in Task 20. Two reasons, and the
# second is the one that mattered:
#
#   1. The frontend ships through Vercel on a push to main; the Edge Functions
#      ship through the Supabase CLI, one named function at a time, at an
#      explicitly named project. A second, stale deploy path in the repository
#      invites someone to use it and quietly serve a different artifact.
#   2. `deploy` and `down` both began with `gcloud config set project
#      trustflow-project`, which changes the AMBIENT gcloud project for every
#      other terminal on the machine. This user runs several GCP-backed
#      projects from one CLI config, so a `make deploy` here could redirect
#      unrelated work. Nothing in this file touches ambient tool state now.
#
# Deliberately not replaced with a working deploy target: nothing here should
# be able to ship anything on its own. How the project actually ships is
# written down in HANDOFF.md, and each step is run deliberately, by name.

IMAGE_NAME=trustflow-web

.PHONY: check build

# Run before every commit.
# The migration check is offline, so it costs nothing and needs no credentials;
# `npm run check:migrations -- --live` additionally compares the local filenames
# against the versions the linked Supabase project has recorded.
check:
	npm run check:migrations && npm test && npm run build

# A local image, for looking at the production bundle in a container. It
# deploys nowhere and is tagged locally rather than at a registry.
#
# The VITE_* values are inlined into the bundle at build time and the Dockerfile
# refuses without them — see the comment there for the silent failure that
# prevents. Passed by NAME, so they are forwarded from this shell rather than
# written into this file or read out of a file here. Export them first, e.g.
#   set -a && . ./.env && set +a && make build
# None of the three is a secret; all are served in the bundle to every visitor.
build:
	docker buildx build --platform linux/amd64 --load \
		--build-arg VITE_SUPABASE_URL \
		--build-arg VITE_SUPABASE_ANON_KEY \
		--build-arg VITE_TURNSTILE_SITE_KEY \
		-t $(IMAGE_NAME) .
