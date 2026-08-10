### Service Project

Create a Pulumi module under `modules/service-project` to create a GCP project within an environment folder

* Builds on top of (composes) the `Project` module — `ServiceProject` is its own `pulumi.ComponentResource` (type `custom:modules:ServiceProject`, args `ServiceProjectArgs`) that instantiates the `Project` module internally as a child, then adds additional resources as needed. It does NOT use TypeScript inheritance (`class ServiceProject extends Project`), because a base `ComponentResource`'s `registerOutputs` conflicts with adding further children after `super()`.
* Depends on resources created by the `organisation` stack (the environment folders and the seed project)
* Dependencies
  * Consumes the `project`, `iam`, and `storage` modules (via relative import)
  * Uses `@pulumi/gcp` (`organizations.getFolders` for the environment-folder lookup, `serviceaccount.Account` for the power-user SA) and `@pulumi/pulumi`
* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID> # used to scope the environment-folder lookup (NOT the project parent — parent is always the environment folder)
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
environment: <environment name (as defined in organisation stack)>
seedProjectID: <seed project ID>
name: <project name base (combined with environment to form the display name and project ID base)>
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)>
apis: # (optional)
  - <one API>
bindingsPowerUser: # (optional)
  group: <group: prefixed email of a power-user group in Google Identity>
  sa: # (optional)
    enabled: <[true|false]>
    name: <service account name (optional defaults to cicd-<name>)>
  bindings:
    - <role_id_a>
    - <role_id_b>
  bindingProjectIAM: # (optional)
    - <role_id_a>
bindingsROUser: #(optional)
  group: <group: prefixed email of a read-only-user group in Google Identity>
  bindings:
    - <role_id_a>
    - <role_id_b>
stateBucket: <[true|false] defaults to true> # (optional)
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Input Types
    * `organisation`, `billing`, `seedProjectID`: [CONV-INPUT]
    * `environment` must be a plain `string` (not an Output) — it is consumed at construction time to resolve the environment folder ID
    * `name` must be a plain `string` (not an Output) — it is consumed at construction time to form the combined `<name>-<environment>` passed to the Project module
    * `defaultLocation` must be a plain `string` (not an Output) — it is a config value used at construction time
    * `bindingsPowerUser.bindingProjectIAM` is optional. Where provided, it is a list of role IDs (`string[]`) that the group (and SA if enabled) are permitted to grant via `roles/resourcemanager.projectIamAdmin`. Must not be empty if provided.
    * `bindingsPowerUser.bindings` must not contain `roles/resourcemanager.projectIamAdmin`. Validate at `ServiceProject` construction time. Error message: `"For roles/resourcemanager.projectIamAdmin, use bindingProjectIAM and provide a list of permitted roles."`
  * `organisation` must be provided
    * Not the project parent (the parent is always the environment folder). Used only to scope the environment-folder lookup (see `environment`).
  * `environment` must be provided
    * Resolve the environment folder ID using `gcp.organizations.getFolders` scoped to the `organisation` ID, matching the folder whose display name equals `environment`. Error if no matching folder is found.
    * The resolved folder ID is passed as the `folder` parent to the internal `Project` module.
  * `name`
    * Project display name and ID base = `<name>-<environment>`, passed to the internal `Project` module `name` field.
    * Name validation is delegated to the `Project` module (single source of truth) — the combined `<name>-<environment>` value is validated there at construction time.
  * `seedProjectID` must be provided (always required). It is the project under which the power-user SA and state bucket are created.
  * `defaultLocation` must be provided (always required, like `seedProjectID`). A valid GCP region used for regional resources (e.g. the state bucket `location`).
  * `apis`
    * Create a new API list with the following APIs and user provided APIs appended if provided
      * cloudresourcemanager.googleapis.com
      * cloudbilling.googleapis.com
      * iam.googleapis.com
      * orgpolicy.googleapis.com (required so this project can serve as the quota project for potential org policy overrides)
  * `bindingsPowerUser` (optional)
    * Validate that `bindingsPowerUser.group` starts with `group:` prefix at construction time. Error if not. Only `group:` principals are accepted for this input.
    * If `bindingsPowerUser.sa` is provided
      * `bindingsPowerUser.sa.enabled` is required. Must be `true` or `false`.
      * Where `true`
        * Create a service account using `gcp.serviceaccount.Account`
        * Create under the seed project (`seedProjectID`)
          * NOTE: This is not a typo, keeping the SA here provides an additional layer of protection from deletion and modification
        * Name: `bindingsPowerUser.sa.name` if provided, otherwise default to `cicd-<name>-<environment>`. Validation deferred to GCP API at apply time.
        * Description: `Service Account for <name>-<environment>. Project wide bindings on this project`
    * Use `iam` module
      * Assign bindings to the project
      * For `bindings`
        * Do NOT permit `roles/resourcemanager.projectIamAdmin`
          * Error Msg : For `roles/resourcemanager.projectIamAdmin`, use `bindingProjectIAM` and provide list of permitted roles
        * Transform input: Create map of `{ <role>: [group:<group>, serviceAccount:<sa-email>] }` where each `<role>` is an entry in `bindingsPowerUser.bindings`. Input to `bindings`
          * Omit Service Account principal if `sa.enabled` is `false` or `sa` is not provided
      * For `bindingProjectIAM` (optional, only processed if provided)
        * Use the `iam` module with both `bindings` and `conditions` parameters
        * `bindings`: `{ 'roles/resourcemanager.projectIamAdmin': [<group>, <serviceAccount:sa-email>] }`
          * Omit SA principal if `sa.enabled` is `false` or `sa` is not provided
        * `conditions`: break `bindingProjectIAM` role list into blocks of 10 (0-indexed). For each block:
          * `role`: `'roles/resourcemanager.projectIamAdmin'`
          * `title`: `condition_block_<blockId>` (e.g. `condition_block_1`, `condition_block_2`)
          * `description`: `Condition Block <blockId>`
          * `expression`: `` `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['${roles.join("', '")}'])` `` — CEL list literal of the roles in this block
          * `members`: `[<group>, <serviceAccount:sa-email>]` (same principals as bindings, omit SA if not enabled)
  * `bindingsROUser` (optional)
    * Validate that `bindingsROUser.group` starts with `group:` prefix at construction time. Error if not. Only `group:` principals are accepted for this input.
    * Use `iam` module
    * Assign bindings to the project
    * Transform input: for each role in `bindingsROUser.bindings`, create an entry `{ <role>: [<group>] }`
  * `stateBucket` (optional, defaults to `true`)
    * If `stateBucket` is `true`
      * Use `storage` module
      * Bucket name = `pulumi-state-<project-id>`, where `<project-id>` is the created project's ID (an Output of the internal `Project` module). Set `postfix: false` — the project ID already guarantees uniqueness.
        * The `storage` module `name` arg must accept `pulumi.Input<string>`; construction-time name validation is skipped for unresolved Outputs.
      * Location = `defaultLocation`
      * Create under the seed project (`seedProjectID`)
        * NOTE: This is not a typo, keeping the bucket here provides an additional layer of protection from deletion and modification
      * IAM bindings are assigned only for principals that are present — skip any binding whose group/SA is not provided (e.g. if `bindingsROUser` or the power-user SA is absent)
      * Use `iam` module for bindings to the `seed` project
        * NOTE: Bound to the seed project (not the individual bucket) — grants list/metadata access to all state buckets in the seed project. Object-level access is handled separately via bucket-level bindings below.
        * Assign `roles/storage.bucketViewer` to (where present)
          * `bindingsPowerUser.group`
          * `bindingsROUser.group`
          * `bindingsPowerUser.sa` (if created)
      * Use `iam` module for bindings to the state bucket
        * Assign `roles/storage.objectAdmin` to (where present)
          * `bindingsPowerUser.group`
          * `bindingsPowerUser.sa` (if created)
        * Assign `roles/storage.objectViewer` to (where present)
          * `bindingsROUser.group`
  * `labels` is optional
    * Apply [CONV-LABELS]. Merge order (later wins): user labels → service-project default `{ environment: "<environment>" }` → parent `Project` module defaults `{ module: "project", deployed_by: "pulumi" }`. Service Project merges its `{ environment }` default, then passes the result to the internal `Project` module, which applies its own defaults.
* Return
  * projectDisplayName — `pulumi.Output<string>` — the project display name
  * projectId — `pulumi.Output<string>` — the `<name>-<environment>-<postfix>` string
  * projectNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * environment — `pulumi.Output<string>` — the environment name
  * bindingsPowerUser — `pulumi.Output<ServiceProjectPowerUser | null>` — as inputted, null if not provided
  * bindingsROUser — `pulumi.Output<ServiceProjectROUser | null>` — as inputted, null if not provided
  * powerUserServiceAccountEmail — `pulumi.Output<string | null>` — SA email if created, null otherwise
  * stateBucketName — `pulumi.Output<string | null>` — final bucket name, null if `stateBucket` is false
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults
