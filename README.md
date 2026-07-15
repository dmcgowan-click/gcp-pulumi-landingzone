# GCP Pulumi LandingZone

UNDER CONSTRUCTION

A GCP Landing Zone written in Pulumi TypeScript

If you're a small to medium business that needs a presence in GCP, this might be the package for you!

Inspired by the [Google Cloud Security Foundations Guide](https://services.google.com/fh/files/misc/google-cloud-security-foundations-guide.pdf), but without the bloat, and designed to be modular so you enable the components you need. Keep It Simple Stupid (KISS) is the aim here. And of course, Pulumi, not Terraform

To get started, click here! To find out more, read on

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
| `make preview-infra` | Preview infrastructure changes |
| `make up-infra` | Deploy infrastructure with Pulumi |
| `make dev-setup` | Set up local development environment |

**Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `STACK_NAME` | `organisation` | Stack to operate on (e.g. `organisation`, `identity`) |
| `STACK_ENV` | `org` | Environment/stack selector for Pulumi |

Set `PULUMI_STATE_BUCKET` to use a GCS backend for state; otherwise Pulumi defaults to local state.

### Standard Template Constructs (STC)

UNDER CONSTRUCTION

An AI experiment (naming convention inspired by the Warhammer 40,000k universe)

Intention is to create a series of `stc` documents that provide detailed descriptions of the components and modules required for the landing zone. This also comes with a `stc` skill to instruct a LLM on how to read and action the documents. The idea been that you can point an LLM to these documents, and reproduce the codebase.

INSTRUCTIONS TO USE THE STC SKILL TO BE ADDED

The `stc/` directory contains specification documents that define how stacks and modules should be generated. These serve as blueprints for AI-assisted code generation and ensure consistency across the codebase.

### Organisation Stack

The foundational Pulumi stack for GCP organisation-level resources. Located in `stacks/organisation/`, it provisions:

- **Folders** — a `common` folder and one folder per environment (e.g. `dev`, `prod`)
- **Org Admin IAM bindings** — assigns organisation-level roles to a Google Identity group, with optional service account creation for CI/CD
- **Seed Project** — a shared project under the `common` folder with essential APIs enabled
- **Pulumi State Bucket** — a GCS bucket for Pulumi state storage (with hex postfix for uniqueness)

Uses the shared `folder`, `iam`, `project`, `storage`, and `labels` modules.

### Identity Stack

Located in `stacks/identity/`, this stack manages Google Workspace users and groups via `@pulumi/google-workspace`. Currently scaffolded with a sample config template.

### Modules

Reusable Pulumi `ComponentResource` modules consumed by stacks via relative import:

| Module | Path | Purpose |
|--------|------|---------|
| Folder | `modules/folder/` | Creates GCP resource folders under an organisation or parent folder, with optional IAM bindings |
| IAM | `modules/iam/` | Non-authoritative IAM member bindings for organisation, folder, project, or resource targets |
| Labels | `modules/labels/` | Sanitises user-provided labels into GCP-compliant format |
| Project | `modules/project/` | Creates a GCP project with APIs, default SA cleanup, optional IAM bindings and labels |
| Storage | `modules/storage/` | Creates a GCS bucket with optional postfix, multi-region support, IAM bindings and labels |

## Getting Started

**hint** get your favourite agent to read this section of README, it will get you setup in minutes!

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

> Set `PULUMI_STATE_BUCKET` to persist state in GCS, e.g. `make up-infra STACK_DIR=stacks/organisation PULUMI_STATE_BUCKET=my-bucket`

> Set `PULUMI_STATE_BUCKET` to persist state in GCS, e.g. `make up-infra STACK_DIR=stacks/organisation PULUMI_STATE_BUCKET=my-bucket`