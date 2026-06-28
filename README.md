# GCP Pulumi LandingZone

A GCP Landing Zone written in Pulumi TypeScript

If you're a small to medium business that needs a presence in GCP, this might be the package for you!

Inspired by the [Google Cloud Security Foundations Guide](https://services.google.com/fh/files/misc/google-cloud-security-foundations-guide.pdf), but without the bloat, and designed to be modular so you enable the components you need. Keep It Simple Stupid (KISS) is the aim here. And of course, Pulumi, not Terraform

To get started, click here! To find out more, read on

**Why a landing zone?**

Setting up a solo greenfield project in GCP is pretty straightforward. Create your project in GCP via the UI, and away you go! But the moment you need multiple users, multiple projects with separate environments, CI/CD pipelines, or integrations with legacy systems — while ensuring you haven't left a security gap that could affect you and your customers — things get much harder to manage. Without help, you can end up spending more time on foundational infrastructure than on your actual application.

That's where a landing zone comes in. It handles the difficult plumbing for you — access control, policies and constraints, project provisioning, and a set of compatible modules for application infrastructure — so you can focus on what matters: building great products for your customers

**Why Pulumi TypeScript and not Terraform?**

Coming from a DevOps background, we always wanted to encourage developers to own not only their application, but also the infrastructure it ran on. However Terraform became a barrier to this, as it became yet another language developers had to learn. We found that using an application-native language reduced the barrier to developers understanding, maintaining, and contributing to their own infrastructure. This improved cross-team collaboration and reduced knowledge silos — exactly what a good DevOps culture should accomplish!

## Features

GCP Pulumi Landing Zone is broken into several distinct parts. This allows for independent deployments of these components along with different deployment strategies, allowing the landing zone to scale as your organisation grows in size and complexity 

### Dev Container Configuration (optional)

**What's a dev container?!**

When opening this repo in vscode, you have the option of using the dev container configuration.

This will load a dedicated docker image based on Ubuntu which will run for the duration of your session and it will contain all the developer tools you would typically need to deploy not only this landing zone, but a variety of applications.

It also has Ollama and OpenCode baked in, giving you the option of running LLMs locally to assist with your development (disclaimer: you will need some decent CPU / GPU specs to run many of these models locally. If lacking, stick to Copilot!)

Compatible with Windows where WSL is installed!

[Dev Container](.devcontainer)

### Organisation Stack

The foundational Pulumi stack for GCP organisation-level resources. Located in `stacks/organisation/`, it uses TypeScript with `@pulumi/gcp` and targets `australia-southeast1` by default.

### Makefile

A Makefile provides the primary interface for infrastructure operations:

| Target | Description |
|--------|-------------|
| `make preview-infra` | Preview infrastructure changes |
| `make up-infra` | Deploy infrastructure with Pulumi |

Set `PULUMI_STATE_BUCKET` to use a GCS backend for state; otherwise Pulumi defaults to local or Pulumi Cloud.

## Getting Started

1. Open the repo in VS Code and accept the dev container prompt (or use `Dev Containers: Reopen in Container`)
2. Run `make preview-infra` to see planned changes
3. Run `make up-infra` to deploy