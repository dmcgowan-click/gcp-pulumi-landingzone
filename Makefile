.PHONY: help prepare-infra preview-infra up-infra migrate-state

.DEFAULT_GOAL := help
help: ## Show this help message
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

WORK_DIR := /home/ubuntu/workspace
PULUMI_DIR := $(WORK_DIR)/pulumi
STACK_DIR := stacks/organisation
PULUMI_STACK ?= org
GCP_REGION ?= australia-southeast1

# Login to GCS backend if PULUMI_STATE_BUCKET is set, otherwise use default (local/Pulumi Cloud)
define pulumi_login
$(if $(PULUMI_STATE_BUCKET),cd $(PULUMI_DIR) && pulumi login gs://$(PULUMI_STATE_BUCKET),)
endef

prepare-infra: ## [auto] Sync Pulumi code and install deps (called by up-infra, preview-infra)
	mkdir -p $(PULUMI_DIR)
	rsync -a --delete --exclude=node_modules $(STACK_DIR)/ $(PULUMI_DIR)/
	cd $(PULUMI_DIR) && npm install

preview-infra: prepare-infra ## Preview infrastructure changes
	$(call pulumi_login)
	cd $(PULUMI_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
	pulumi preview --refresh

up-infra: prepare-infra ## Deploy infrastructure with Pulumi
	$(call pulumi_login)
	cd $(PULUMI_DIR) && pulumi stack select $(PULUMI_STACK) --create 2>/dev/null; \
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