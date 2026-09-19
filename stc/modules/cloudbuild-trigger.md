### CloudBuild Trigger

Create a Pulumi `ComponentResource` module under `modules/cloudbuild-trigger` to create a CloudBuild trigger and an associated service account with permission to impersonate the provided service accounts

> **Design note:** At this time the module supports only: repository-invoked triggers sourced from 2nd generation Cloud Build repositories, with inline custom YAML build configuration.

* No additional dependencies beyond `@pulumi/gcp` and `@pulumi/pulumi` (consumes the local `iam` module)
* Accept an input based on the following YAML definition

```yaml
name: <string, required — GCP resource name prefix. Validated: ^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars>
project: <project ID string, required — project where the trigger and its service account are created, and where roles/artifactregistry.reader is granted>
description: <string (optional, default: "Trigger <name>")>
region: <valid region, required — the trigger location>
event: <[push-to-branch | push-new-tag | pull-request], required>
source: <any full 2nd gen repository resource name, e.g. projects/<p>/locations/<r>/connections/<c>/repositories/<repo> (e.g. as output by the cicd stack repositoryLinks)>
branch: <branch (or tag, for push-new-tag) regex to trigger on (defaults to .*)>
configuration:
  type: <[Cloud Build configuration file] default: Cloud Build configuration file. Only this value supported — error otherwise>
  location: <[inline-custom | inline-predefined | repository] default: inline-custom. Only inline-custom supported — error otherwise>
  inlineCustom: # required when location = inline-custom — valid Cloud Build definition, e.g.
    # steps:
    #   - name: ubuntu
    #     args:
    #       - echo
    #       - hello world
saAssume: # (optional) — service account emails the trigger SA is granted permission to impersonate (roles/iam.serviceAccountTokenCreator)
  - <service account email>
```

* Requirements:
  * Input Types
    * `project`, `source`: [CONV-INPUT]
    * `saAssume` entries and `resource.identifier`: [CONV-INPUT]
    * `project` must be provided (non-empty). Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number
    * `region` must be provided (non-empty). Used as the trigger `location`.
    * `name` must be provided. Validate: `^[a-z]([-a-z0-9]*[a-z0-9])?$`, max 63 chars.
    * `event` must be provided and one of `push-to-branch`, `push-new-tag`, `pull-request`. Error otherwise.
    * `source` must be provided (non-empty). Any full 2nd gen repository resource name (e.g. as output by the `cicd` stack `repositoryLinks`).
    * `branch` is optional, defaults to `.*`.
    * `description` if not provided defaults to `Trigger <name>`
    * `saAssume` is optional. Where provided, each entry must be a non-empty service account email; existence deferred to the GCP API [CONV-VALIDATE-API]
    * `configuration`
      * `type` is optional, defaults to `Cloud Build configuration file`. Only this value is supported — error otherwise.
      * `location` is optional, defaults to `inline-custom`. Only `inline-custom` is supported — error otherwise (`inline-predefined`, `repository` not yet supported).
      * `inlineCustom` is required when `location` = `inline-custom`. Error if absent. Typed as (assignable to) `gcp.types.input.cloudbuild.TriggerBuild`.
  * Create the Cloud Build trigger
    * Use `gcp.cloudbuild.Trigger`
    * `project` = `project`
    * `location` = `region`
    * `name` = `name`
    * `description` = `description` (or the default `Trigger <name>`)
    * `serviceAccount` = the created `cb-<name>` service account, so the trigger runs as that SA
      * The service account is created first; the trigger references its email, and the implicit Pulumi dependency guarantees the SA exists before the trigger is created
    * `repositoryEventConfig`
      * `repository` = `source` (full 2nd gen repository resource name)
      * Map `event` to the event filter (using `branch` as the regex, default `.*`):
        * `push-to-branch` → `push` with `branch` = `branch`
        * `push-new-tag` → `push` with `tag` = `branch`
        * `pull-request` → `pullRequest` with `branch` = `branch`
    * Build configuration (`location` = `inline-custom`)
      * `configuration.inlineCustom` is typed as (assignable to) `gcp.types.input.cloudbuild.TriggerBuild` — the inline Cloud Build definition (`steps`, `images`, etc.)
      * Passed through as the trigger's `build` argument; structure validation deferred to the GCP API [CONV-VALIDATE-API]
      * Because the trigger always runs under the module-created custom SA, GCP requires a build logging option. Default `options.logging` = `CLOUD_LOGGING_ONLY` when the caller has not set `options.logging`; any caller-provided `options` take precedence.
  * Create a service account using `gcp.serviceaccount.Account`
    * Create under `project`
    * Account ID = `cb-<name>`. SA ID max 30 chars — validation deferred to GCP API at apply time [CONV-VALIDATE-API].
      * If `cb-<name>` exceeds 30 chars, shorten deterministically: truncate the leading portion and append a short hash suffix derived from the full `cb-<name>` (e.g. `cb-<truncated>-<hash>`) so the ID stays ≤ 30 chars and remains stable across runs
    * Description = `Service Account for <description>. Assume to authorised service accounts` (`description` = default description if not otherwise provided)
  * Grant artifact read access via the `iam` module (always granted)
    * The created `cb-<name>` SA is granted `roles/artifactregistry.reader` on `project`, so build steps can pull and read all artifacts across the project's registries
    * Use the `iam` module with:
      * `project` = `project`
      * `bindings` = `{ roles/artifactregistry.reader: [serviceAccount:<cb-<name> SA email>] }`
  * Grant assume (token creator) permissions via the `iam` module
    * `saAssume` is optional. Where provided, the created `cb-<name>` SA is granted `roles/iam.serviceAccountTokenCreator` on each listed service account so it may impersonate them
    * For each service account email in `saAssume` (index `i`):
      * Create one `iam` component named `<name>-assume-<i>` (index-based, since entries may be Outputs and cannot be used in resource names)
      * `resource.type` = `service_account`
      * `resource.identifier` = the fully-qualified SA resource name `projects/-/serviceAccounts/<service account email>` (the `iam` module maps this to `serviceAccountId`, which requires the resource-name form, not a bare email; `-` is the project wildcard)
      * `bindings` = `{ roles/iam.serviceAccountTokenCreator: [serviceAccount:<cb-<name> SA email>] }`
      * Existence of the target SA is deferred to the GCP API at apply time [CONV-VALIDATE-API]
    * When `saAssume` is omitted or empty, no token-creator bindings are created
* Return
  * triggerId — `pulumi.Output<string>` — the Cloud Build trigger ID
  * triggerName — `pulumi.Output<string>` — the trigger name
  * serviceAccountEmail — `pulumi.Output<string>` — the created `cb-<name>` SA email
