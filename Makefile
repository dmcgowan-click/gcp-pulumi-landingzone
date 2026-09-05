.PHONY: help prepare-infra preview-infra up-infra migrate-state dev-setup

.DEFAULT_GOAL := help
help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

WORK_DIR := /home/ubuntu/workspace
PULUMI_DIR := $(WORK_DIR)/pulumi
STACK_ENV ?= org
GCP_REGION ?= australia-southeast1
PULUMI_STACK ?= $(STACK_ENV)

# Login to GCS backend. Priority: state.yaml in stack dir > PULUMI_STATE_BUCKET env var > local state
# Bucket is selected from state.yaml by STACK_ENV (defaults to 'org' for landing zone stacks)
define pulumi_login
$(if $(shell test -f $(STACK_DIR)/state.yaml && echo yes),cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi login gs://$$(yq -r '.["$(STACK_ENV)"]' state.yaml),$(if $(PULUMI_STATE_BUCKET),cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi login gs://$(PULUMI_STATE_BUCKET),cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi login --local))
endef

_check-vars:
	@test -n "$(STACK_DIR)" || (echo "ERROR: STACK_DIR is required. Set to the stack directory under stacks/, e.g. STACK_DIR=stacks/identity" && exit 1)
	@test -n "$(STACK_ENV)" || (echo "ERROR: STACK_ENV is required. Set to the environment to deploy, e.g. STACK_ENV=org" && exit 1)
	@test -d "$(STACK_DIR)" || (echo "ERROR: STACK_DIR '$(STACK_DIR)' does not exist" && exit 1)

# Google Workspace provider version (bridged Terraform provider, not on npm)
GWS_PROVIDER_VERSION ?= 0.7.0

dev-setup: ## Install root node_modules for editor type resolution
	npm install
	@if grep -q '"@pulumi/googleworkspace"' package.json; then \
		STACK_WITH_GWS=$$(grep -rl '"@pulumi/googleworkspace"' stacks/*/package.json 2>/dev/null | head -1 | xargs -r dirname); \
		if [ -n "$$STACK_WITH_GWS" ]; then \
			if [ ! -d "$$STACK_WITH_GWS/sdks/googleworkspace/bin" ]; then \
				echo "Generating Google Workspace SDK in $$STACK_WITH_GWS/sdks..."; \
				cd "$$STACK_WITH_GWS" && pulumi package add terraform-provider hashicorp/googleworkspace $(GWS_PROVIDER_VERSION); \
			else \
				echo "Google Workspace SDK already exists at $$STACK_WITH_GWS/sdks/googleworkspace"; \
			fi; \
		fi; \
	fi

prepare-infra: _check-vars ## [auto] Sync Pulumi code and install deps (called by up-infra, preview-infra)
	mkdir -p $(PULUMI_DIR)/$(STACK_DIR)
	rsync -a --delete --exclude=node_modules $(STACK_DIR)/ $(PULUMI_DIR)/$(STACK_DIR)/
	@if [ -d modules ]; then \
		mkdir -p $(PULUMI_DIR)/modules && \
		rsync -a --delete --exclude=node_modules modules/ $(PULUMI_DIR)/modules/; \
	fi
	@if grep -q '"@pulumi/googleworkspace"' $(PULUMI_DIR)/$(STACK_DIR)/package.json; then \
		if [ ! -d $(PULUMI_DIR)/$(STACK_DIR)/sdks/googleworkspace/bin ]; then \
			echo "Generating Google Workspace SDK for $(STACK_DIR)..."; \
			cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi package add terraform-provider hashicorp/googleworkspace $(GWS_PROVIDER_VERSION); \
		else \
			echo "Google Workspace SDK already exists for $(STACK_DIR)"; \
		fi; \
	fi
	cd $(PULUMI_DIR)/$(STACK_DIR) && npm install
	@if [ -d modules ]; then \
		ln -sfn $(PULUMI_DIR)/$(STACK_DIR)/node_modules $(PULUMI_DIR)/modules/node_modules; \
	fi

# Stacks using @pulumi/googleworkspace store a short-lived access token in
# Pulumi state. --refresh would fail with ACCESS_TOKEN_EXPIRED on stale state,
# so we only add --refresh for stacks that don't use that provider.
REFRESH_FLAG = $(if $(shell grep -q '"@pulumi/googleworkspace"' $(PULUMI_DIR)/$(STACK_DIR)/package.json 2>/dev/null && echo yes),,--refresh)

preview-infra: prepare-infra ## Preview infrastructure changes
	$(call pulumi_login)
	cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
	pulumi preview $(REFRESH_FLAG)

up-infra: prepare-infra ## Deploy infrastructure with Pulumi
	$(call pulumi_login)
	cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
	pulumi up --yes $(REFRESH_FLAG)

migrate-state: _check-vars ## Migrate local Pulumi state to GCS backend (reads bucket from state.yaml)
	@test -f "$(STACK_DIR)/state.yaml" || (echo "ERROR: $(STACK_DIR)/state.yaml not found. Create it with the GCS bucket name from stack outputs." && exit 1)
	@BUCKET=$$(yq -r '.["$(STACK_ENV)"]' $(STACK_DIR)/state.yaml); \
	PROJECT=$$(yq -r '.name' $(STACK_DIR)/Pulumi.yaml); \
	LOCAL_STATE=$$HOME/.pulumi/stacks/$$PROJECT/$(PULUMI_STACK).json; \
	test -f "$$LOCAL_STATE" || (echo "ERROR: Local state file not found at $$LOCAL_STATE" && exit 1); \
	GCS_PATH=".pulumi/stacks/$$PROJECT/$(PULUMI_STACK).json"; \
	echo "Migrating local state to gs://$$BUCKET/$$GCS_PATH"; \
	gsutil cp "$$LOCAL_STATE" "gs://$$BUCKET/$$GCS_PATH" && \
	echo "State migrated successfully to gs://$$BUCKET/$$GCS_PATH"