.PHONY: help prepare-infra preview-infra up-infra migrate-state dev-setup

.DEFAULT_GOAL := help
help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

WORK_DIR := /home/ubuntu/workspace
PULUMI_DIR := $(WORK_DIR)/pulumi
STACK_ENV ?= org
GCP_REGION ?= australia-southeast1
PULUMI_STACK ?= $(STACK_ENV)

# Login to GCS backend if PULUMI_STATE_BUCKET is set, otherwise use local state
define pulumi_login
$(if $(PULUMI_STATE_BUCKET),cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi login gs://$(PULUMI_STATE_BUCKET),cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi login --local)
endef

_check-vars:
	@test -n "$(STACK_DIR)" || (echo "ERROR: STACK_DIR is required. Set to the stack directory under stacks/, e.g. STACK_DIR=stacks/identity" && exit 1)
	@test -n "$(STACK_ENV)" || (echo "ERROR: STACK_ENV is required. Set to the environment to deploy, e.g. STACK_ENV=org" && exit 1)
	@test -d "$(STACK_DIR)" || (echo "ERROR: STACK_DIR '$(STACK_DIR)' does not exist" && exit 1)

dev-setup: ## Install root node_modules for editor type resolution
	npm install

prepare-infra: _check-vars ## [auto] Sync Pulumi code and install deps (called by up-infra, preview-infra)
	mkdir -p $(PULUMI_DIR)/$(STACK_DIR)
	rsync -a --delete --exclude=node_modules $(STACK_DIR)/ $(PULUMI_DIR)/$(STACK_DIR)/
	@if [ -d modules ]; then \
		mkdir -p $(PULUMI_DIR)/modules && \
		rsync -a --delete --exclude=node_modules modules/ $(PULUMI_DIR)/modules/; \
	fi
	cd $(PULUMI_DIR)/$(STACK_DIR) && npm install
	@if [ -d modules ]; then \
		ln -sfn $(PULUMI_DIR)/$(STACK_DIR)/node_modules $(PULUMI_DIR)/modules/node_modules; \
	fi

preview-infra: prepare-infra ## Preview infrastructure changes
	$(call pulumi_login)
	cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
	pulumi preview --refresh

up-infra: prepare-infra ## Deploy infrastructure with Pulumi
	$(call pulumi_login)
	cd $(PULUMI_DIR)/$(STACK_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
	pulumi up --yes --refresh

#COMMENTED OUT: Will re-enable once the bootstrap infra is in place
# migrate-state: prepare-infra ## Migrate local Pulumi state to GCS backend (requires PULUMI_STATE_BUCKET)
# ifndef PULUMI_STATE_BUCKET
# 	$(error PULUMI_STATE_BUCKET is required. Usage: make migrate-state PULUMI_STATE_BUCKET=my-bucket)
# endif
# 	cd $(PULUMI_DIR) && pulumi login --local
# 	cd $(PULUMI_DIR) && pulumi stack select $(PULUMI_STACK) 2>/dev/null || \
# 		(echo "ERROR: Stack $(PULUMI_STACK) not found in local state"; exit 1)
# 	cd $(PULUMI_DIR) && pulumi stack export --file /tmp/pulumi-state-export.json
# 	cd $(PULUMI_DIR) && pulumi login gs://$(PULUMI_STATE_BUCKET)
# 	cd $(PULUMI_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null
# 	cd $(PULUMI_DIR) && pulumi stack import --file /tmp/pulumi-state-export.json
# 	@rm -f /tmp/pulumi-state-export.json
# 	@echo "State migrated successfully to gs://$(PULUMI_STATE_BUCKET)"