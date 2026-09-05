# GCP Pulumi LandingZone

UNDER CONSTRUCTION

A GCP Landing Zone written in Pulumi TypeScript

If you're a small to medium business that needs a presence in GCP, this might be the package for you!

Inspired by the [Google Cloud Security Foundations Guide](https://services.google.com/fh/files/misc/google-cloud-security-foundations-guide.pdf), but without the bloat, and designed to be modular so you enable the components you need. Keep It Simple Stupid (KISS) is the aim here. And of course, Pulumi, not Terraform

To get started, [click here!](#getting-started) To find out more, read on

**Why a landing zone?**

Setting up a solo greenfield project in GCP is pretty straightforward. Create your project in GCP via the UI, and away you go! But the moment you need multiple users, multiple projects with separate environments, CI/CD pipelines, or integrations with legacy systems — while ensuring you haven't left a security gap that could affect you and your customers — things get much harder to manage. Without help, you can end up spending more time on foundational infrastructure than on your actual application.

That's where a landing zone comes in. It handles the difficult plumbing for you — access control, policies and constraints, project provisioning and compatible modules for application infrastructure — so you can focus on what matters: building great products for your customers

**Why Pulumi TypeScript and not Terraform?**

Coming from a DevOps background, we always wanted to encourage developers to own not only their application, but also the infrastructure it ran on. However Terraform became a barrier to this, as it became yet another language developers had to learn. We found that using an application-native language reduced the barrier to developers understanding, maintaining, and contributing to their own infrastructure. This improved cross-team collaboration and reduced knowledge silos — exactly what a good DevOps culture should accomplish!

## Architecture

TO BE UPDATED

## Components

GCP Pulumi Landing Zone is broken into several distinct parts. This allows for independent deployments of these components along with different deployment strategies, allowing the landing zone to scale as your organisation grows in size and complexity 

### Dev Container Configuration (optional)

**What's a dev container?!**

When opening this repo in vscode, you have the option of using the dev container configuration.

This will load a dedicated docker image based on Ubuntu which will run for the duration of your session and it will contain all the developer tools you would typically need to deploy not only this landing zone, but a variety of applications.

It also has Ollama and OpenCode baked in, giving you the option of running LLMs locally to assist with your development (disclaimer: you will need some decent CPU / GPU specs to run many of these models locally. If lacking, stick to Copilot!)

Compatible with Windows where WSL is installed!

[Dev Container](.devcontainer)

### Makefile

The Makefile provides the primary interface for infrastructure operations and supports multiple stacks:

| Target | Description |
|--------|-------------|
| `make dev-setup` | Install root node_modules for editor type resolution (also generates Google Workspace SDK if needed) |
| `make preview-infra` | Preview infrastructure changes |
| `make up-infra` | Deploy infrastructure with Pulumi |
| `make migrate-state` | Migrate local Pulumi state to GCS backend (reads bucket from `state.yaml`) |

**Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `STACK_DIR` | *(required)* | Stack directory to operate on (e.g. `stacks/organisation`, `stacks/identity`) |
| `STACK_ENV` | `org` | Environment/stack selector for Pulumi |
| `GCP_REGION` | `australia-southeast1` | GCP region |
| `PULUMI_STACK` | `$(STACK_ENV)` | Pulumi stack name |
| `GWS_PROVIDER_VERSION` | `0.7.0` | Google Workspace bridged Terraform provider version |

**State backend** priority: `state.yaml` in the stack directory > `PULUMI_STATE_BUCKET` env var > local state.

### Standard Template Constructs (STC)

UNDER CONSTRUCTION

An AI experiment (naming convention inspired by the Warhammer 40,000k universe)

Intention is to create a series of `stc` documents that provide detailed descriptions of the components and modules required for the landing zone. This also comes with a `stc` skill to instruct a LLM on how to read and action the documents. The idea been that you can point an LLM to these documents, and reproduce the codebase.

INSTRUCTIONS TO USE THE STC SKILL TO BE ADDED

The `stc/` directory contains specification documents that define how stacks and modules should be generated. These serve as blueprints for AI-assisted code generation and ensure consistency across the codebase.

### Organisation Stack

The foundational Pulumi stack for GCP organisation-level resources. Located in `stacks/organisation/`, it provisions:

- **Folders** — a `common` folder and one folder per environment (e.g. `dev`, `prod`), each with domain-wide `folderViewer` bindings. Environment folders can also receive user-supplied IAM bindings (merged with the domain binding)
- **Domain-wide IAM** — assigns `organizationViewer` to the Google Cloud domain at the organisation level
- **Org Admin IAM bindings** — assigns organisation-level roles to a Google Identity group, with optional service account creation for CI/CD
- **Seed Project** — a shared project under the `common` folder with essential APIs enabled
- **Pulumi State Bucket** — a GCS bucket for Pulumi state storage (with hex postfix for uniqueness)
- **Root DNS Zone** (optional) — a public Cloud DNS zone in the seed project, used as the delegation parent for per-project child zones

Uses the shared `folder`, `iam`, `project`, `storage`, `dns-zone`, and `labels` modules.

### Identity Stack

Located in `stacks/identity/`, this stack manages Google Workspace users and groups via `@pulumi/googleworkspace` using domain-wide delegation. It provisions:

- **Users** — creates Google Workspace users with auto-generated passwords (secrets), recovery contacts, and forced password change on first login
- **Groups** — creates groups and assigns memberships with proper dependency ordering. Groups can contain both user and group members (nested groups); groups referenced as members of other groups are created first to satisfy dependencies

Requires a service account with domain-wide delegation (created by the Organisation stack) and the Admin SDK API enabled on the seed project. See `stacks/identity/Pulumi.org.sample.yaml` for config template.

### Project Factory Stack

Located in `stacks/project-factory/`, this stack provisions service projects using a three-tier config model:

1. **Org-common** (`Pulumi-common.yaml`) — shared values across all initiatives (organisation ID, billing account, seed project ID, default location)
2. **Initiative-common** (`Pulumi.<initiative>-common.yaml`) — per-initiative defaults (project name base, APIs, binding configs, labels)
3. **Environment** (`Pulumi.<initiative>-<env>.yaml` / stack config) — per-environment overrides and principals

Stack name must follow `<initiative>-<environment>` format (e.g. `myapp-dev`). Environment-level config takes priority over initiative-common for overridable parameters (`bindingsPowerUserConfig`, `bindingsROUserConfig`, `stateBucket`, `defaultProjectZone`).

Optionally provisions DNS zones per project via `defaultProjectZone` (child zone delegated from the organisation root zone) and `additionalProjectZones` (arbitrary extra zones).

Uses the `service-project`, `labels` modules. See `Pulumi-common.sample.yaml`, `Pulumi.myapp-common.sample.yaml`, and `Pulumi.myapp-dev.sample.yaml` for config templates.

### CICD Stack

Located in `stacks/cicd/`, this stack provisions CI/CD infrastructure. It creates:

- **CICD Project** — a dedicated GCP project under the `common` folder with Artifact Registry and related APIs enabled
- **Artifact Registries** — configurable repositories supporting Docker, npm, and Python formats with cleanup policies (30-day TTL, untagged image cleanup for Docker), optional multi-region placement, and immutable tag policies (Docker only)

Auto-discovers the `common` folder if no folder ID is provided. Uses the shared `project` and `labels` modules. See `stacks/cicd/Pulumi.org.sample.yaml` for config template.

### Modules

Reusable Pulumi `ComponentResource` modules consumed by stacks via relative import:

| Module | Path | Purpose |
|--------|------|---------|
| Folder | `modules/folder/` | Creates GCP resource folders under an organisation or parent folder, with optional IAM bindings |
| IAM | `modules/iam/` | Non-authoritative IAM member bindings for organisation, folder, project, or resource targets. Supports conditional bindings via CEL expressions |
| Labels | `modules/labels/` | Sanitises user-provided labels into GCP-compliant format |
| Project | `modules/project/` | Creates a GCP project with APIs, default SA cleanup, optional IAM bindings and labels |
| Service Project | `modules/service-project/` | Creates a GCP project in an environment folder with power-user/read-only IAM bindings, optional CICD service account, optional Pulumi state bucket, and optional DNS zones |
| DNS Zone | `modules/dns-zone/` | Creates a GCP Cloud DNS managed zone (public) with labels, exports zone name and name servers |
| Storage | `modules/storage/` | Creates a GCS bucket with optional postfix, multi-region support, IAM bindings and labels |
| IP Address | `modules/ip-address/` | Reserves an external IP address (Regional or Global) with labels, exports the allocated address and self link |

## Getting Started

**hint** get your favourite agent to read this section of README, it will get you setup in minutes!

### Bootstrap

1. Open the repo in VS Code 
   * Optionally accept the dev container prompt (or use `Dev Containers: Reopen in Container`) to open in a dev container
2. Run `make dev-setup` to install root dependencies for editor type resolution
3. Copy the sample config for your stack and fill in your values:
```bash
   cp stacks/organisation/Pulumi.org.sample.yaml stacks/organisation/Pulumi.org.yaml
```
4. Authenticate with GCP: `gcloud auth login && gcloud auth application-default login`
5. Preview your changes: `make preview-infra STACK_DIR=stacks/organisation`
6. Deploy: `make up-infra STACK_DIR=stacks/organisation`

### Configure State

Previous steps will have created a GCP Storage Bucket for storage of the Pulumi state file. This bucket should be used for maintaining Pulumi state going forward

1. Copy the sample state file config and populate with the newly created storage bucket
```bash
   cp stacks/organisation/state.sample.yaml stacks/organisation/state.yaml
```
   * Bucket name can be retrieved from the Pulumi outputs after the bootstrapping. Look for `pulumi-state-organisation-<random hex>`
2. Copy local Pulumi state to the storage bucket: `make migrate-state STACK_DIR=stacks/organisation`

### Setting Up and Running GCP Stacks

All stacks will have one of the following sample configuration files

* `Pulumi.org.sample.yaml` for org wide deployments
* `Pulumi.ENV.sample.yaml` for deployments that will span across multiple environments (example, project factory)

Rename the files to the following accordingly

* `Pulumi.org.yaml`
* `Pulumi.dev.yaml` #dev is an example
* `Pulumi.prod.yaml` #prod is an example

And populate the values accordingly. Overwhelmed?! Start small and expand as needed

All stacks can be run as follows after the bootstrap step

**Org Only stacks (e.g, organisation, identity)**
```bash
make up-infra STACK_DIR=stacks/<stack folder name>
```

**Per Environment Stacks (e.g, project-factory)**
```bash
make up-infra STACK_DIR=stacks/<stack folder name> STACK_ENV=<where yaml is Pulumi.dev.yaml, env is 'dev'>
```

All stacks will contain the following configuration file, the same as the organisation stack used in the bootstrap step

* `state.sample.yaml`

While not required, it is highly recommended to set this up so your Pulumi state is managed in the cloud, and not a local system. This is not just for backup, but also so multiple engineers can manage the same stack

Rename file to the following and populate with the stack bucket name (created after bootstrap)

* `state.yaml`

#### Extra Setup for the Identity Stack

The Identity stack requires some additional configuration as it technically uses the Google Workspace provider. Perform these steps once you have completed above. This must be manually performed

* In the GCP console, locate the service account created under the organisation stack (will be in the seed project) and copy the **Unique ID**
* In the Google Admin console, go to Security > Access and data control > API Controls > MANAGE DOMAIN WIDE DELEGATION
* Click Add new, enter the **Unique ID** from previously then add the following OAuth scopes
   * `https://www.googleapis.com/auth/admin.directory.user`
   * `https://www.googleapis.com/auth/admin.directory.group`
   * `https://www.googleapis.com/auth/admin.directory.group.member`

#### Extra Instructions for the Project Factory stack

Project factory works a bit differently to other stacks, due to the overhead required to provision a full service project. 

In the project factory stack, **each project** is its own deployment, regardless of which environment it belongs to. This reduces the overhead of interacting with all projects when potentially a change only applies to a single or handful of projects. This also allows configuration of CICD to target multiple projects in parallel based on file updates, improving deployment times and reducing impact of misconfigurations

Project Factory uses a **three-tier config model**:

| Tier | File | Scope | Purpose |
|------|------|-------|---------|
| Org-common | `Pulumi-common.yaml` | All projects | Organisation ID, billing account, seed project, default region |
| Initiative-common | `Pulumi.<initiative>-common.yaml` | All environments for one initiative | Project name base, APIs, default IAM bindings, labels |
| Environment | `Pulumi.<initiative>-<env>.yaml` | Single project deployment | Per-project principals, IAM overrides, labels |

Settings defined at the environment level take priority over initiative-common for overridable parameters (IAM bindings, state bucket)

**Setup steps:**

1. Copy and populate the org-common config (one per landing zone):
```bash
cp stacks/project-factory/Pulumi-common.sample.yaml stacks/project-factory/Pulumi-common.yaml
```

2. Copy and populate the initiative-common config (one per initiative/app):
```bash
cp stacks/project-factory/Pulumi.myapp-common.sample.yaml stacks/project-factory/Pulumi.<your-initiative>-common.yaml
```

3. Copy and populate the environment config (one per project deployment):
```bash
cp stacks/project-factory/Pulumi.myapp-dev.sample.yaml stacks/project-factory/Pulumi.<your-initiative>-<env>.yaml
```

And populate the values accordingly. Overwhelmed?! As before, start small and expand as needed. And use your agents to help!

**Deploying a project:**

The stack name must match the `<initiative>-<environment>` pattern from the filename. For example, to deploy the project defined in `Pulumi.myapp-dev.yaml`:

```bash
make up-infra STACK_DIR=stacks/project-factory STACK_ENV=myapp-dev
```

To deploy the same initiative to production (`Pulumi.myapp-prod.yaml`):

```bash
make up-infra STACK_DIR=stacks/project-factory STACK_ENV=myapp-prod
```