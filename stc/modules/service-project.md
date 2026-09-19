### Service Project

Create a Pulumi `ComponentResource` module under `modules/service-project` to create a GCP project within an environment folder

* Builds on top of (composes) the `Project` module — `ServiceProject` is its own `pulumi.ComponentResource` that instantiates the `Project` module internally as a child, then adds additional resources as needed. It does NOT use TypeScript inheritance (`class ServiceProject extends Project`), because a base `ComponentResource`'s `registerOutputs` conflicts with adding further children after `super()`.
* Depends on resources created by the `organisation` stack (the environment folders and the seed project)
* Dependencies
  * Consumes the `project`, `iam`, `storage`, `dns-zone`, and `org-policy` modules (via relative import)
  * Uses `@pulumi/gcp` v8+ (`organizations.getFolders` for the environment-folder lookup, `serviceaccount.Account` for the power-user SA, `dns.getManagedZone` / `dns.RecordSet` for DNS delegation, `Provider` for quota-project scoped org policy calls) and `@pulumi/pulumi`. v8 is required because managed constraint `parameters` fields are not supported in v7.
  * Calling stack must include `@pulumi/random` in `package.json` (inherited via `Project` module composition — required for [CONV-POSTFIX])
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
projectZones: # (optional)
  publicDefault: # (optional)
    rootZoneName: <zone resource name of the root zone. Created by the organisation stack>
  additional: # (optional)
    <dnsName>:
      visibility: <[public | private] defaults to public>
      zoneName: <name of zone> # (optional - derived from dnsName if not provided)
      description: <description of zone> # (optional - derived from dnsName if not provided)
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Input Types
    * `organisation`, `billing`, `seedProjectID`: [CONV-INPUT]
    * `organisation` is also used to construct the `allowedPrincipalSets` value for the HTTPS LB service agent org policy override (see below)
    * `environment` must be a plain `string` (not an Output) — it is consumed at construction time to resolve the environment folder ID
    * `name` must be a plain `string` (not an Output) — it is consumed at construction time to form the combined `<name>-<environment>` passed to the Project module
    * `defaultLocation` must be a plain `string` (not an Output) — it is a config value used at construction time
    * `bindingsPowerUser.group`, `bindingsROUser.group`: plain `string` (not `Input<string>`) — validated at construction time (must start with `group:` prefix)
    * `rootZoneName` (within `projectZones.publicDefault`): plain `string` — a GCP DNS managed zone resource name
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
  * `apis` (optional in YAML — the 4 default APIs below are always included regardless)
    * Create a new API list with the following default APIs. User-provided APIs (if any) are appended. The combined list is passed to the internal `Project` module.
      * cloudresourcemanager.googleapis.com
      * cloudbilling.googleapis.com
      * iam.googleapis.com
      * orgpolicy.googleapis.com (required so this project can serve as the quota project for potential org policy overrides)
      * `dns.googleapis.com` — added automatically when `projectZones` is provided
  * HTTPS LB service agent org policy override
    * When `compute.googleapis.com` is present in the combined API list (default + user-provided), create a project-level org policy override for the `iam.managed.allowedPolicyMembers` managed constraint
    * The HTTPS LB service agent (`service-{PROJECT_NUMBER}@https-lb.iam.gserviceaccount.com`) is created when the Compute API is enabled but is not covered by the organisation-level `allowedPrincipalSets` principal set — it must be explicitly added via `allowedMemberSubjects`
    * Create a `gcp.Provider` scoped to the new project (`billingProject` = project ID, `userProjectOverride: true`) — the OrgPolicy API requires a quota project when using user ADC credentials
    * Use the `org-policy` module to create the override with:
      * `project` = project ID output
      * `policyName` = `iam.managed.allowedPolicyMembers`
      * `parameters` = JSON containing:
        * `allowedPrincipalSets`: `["//cloudresourcemanager.googleapis.com/organizations/<organisation>"]`
        * `allowedMemberSubjects`: `["serviceAccount:service-<PROJECT_NUMBER>@https-lb.iam.gserviceaccount.com"]`
      * Pass the quota provider via `providers` option and `dependsOn: [project]`
  * `bindingsPowerUser` (optional)
    * Validate that `bindingsPowerUser.group` starts with `group:` prefix at construction time. Error if not. Only `group:` principals are accepted for this input.
    * If `bindingsPowerUser.sa` is provided
      * `bindingsPowerUser.sa.enabled` is required. Must be `true` or `false`.
      * Where `true`
        * Create a service account using `gcp.serviceaccount.Account`
        * Create under the seed project (`seedProjectID`)
          * NOTE: This is not a typo, keeping the SA here provides an additional layer of protection from deletion and modification
        * Name: `bindingsPowerUser.sa.name` if provided, otherwise default to `cicd-<name>-<environment>`. SA ID max 30 chars — validation deferred to GCP API at apply time [CONV-VALIDATE-API].
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
        * `conditions`: break `bindingProjectIAM` role list into blocks of 10. Internal array indexing is 0-based; user-visible block IDs start at 1 (`blockId = arrayIndex + 1`). For each block:
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
        * If multiple `ServiceProject` instances share the same `seedProjectID`, each creates its own IAM member bindings. Use the service-project name in the Pulumi resource name to avoid conflicts between instances.
        * Assign `roles/storage.bucketViewer` to (where present)
          * `bindingsPowerUser.group`
          * `bindingsROUser.group`
          * `bindingsPowerUser.sa` (if created)
      * Pass bucket-level IAM via the `storage` module's `bindings` parameter (dynamically exclude absent principals):
        * `roles/storage.objectAdmin`: `bindingsPowerUser.group`, `bindingsPowerUser.sa` (if created)
        * `roles/storage.objectViewer`: `bindingsROUser.group` (if provided)
  * `projectZones` (optional)
    * If `publicDefault` is provided
      * Use `dns-zone` module
      * `rootZoneName` must be declared
        * Look up root zone via `gcp.dns.getManagedZone` in `seedProjectID` project using `rootZoneName`
        * Acquire root zone `dnsName` (FQDN) from the lookup result
      * Create new public zone in the newly created project
        * `project` = project ID output from the internal `Project` module
        * `dnsName` = `<name>-<environment>` + `.` + acquired root zone `dnsName` (trailing dot normalised)
        * `zoneName` = `dnsName` with dots replaced by hyphens and trailing hyphen removed
        * `description` = `DNS zone for <dnsName>`
        * `visibility` = public
      * Create NS delegation record in the root zone via `gcp.dns.RecordSet` in `seedProjectID` project
        * `managedZone` = root zone name (from lookup above)
        * `name` = child zone `dnsName` (with trailing dot)
        * `type` = `NS`
        * `ttl` = `300`
        * `rrdatas` = child zone `nameServers` output (from `dns-zone` module return)
      * Pass merged labels (same labels passed to the internal `Project` module) to the `dns-zone` module `labels` parameter
    * If `additional` is provided
      * For each entry
        * Use `dns-zone` module
        * Create new zone in the newly created project
          * `project` = project ID output from the internal `Project` module
          * `dnsName` = entry key
          * `zoneName` = if provided, use entry value; otherwise derive from `dnsName` (dots replaced by hyphens, trailing hyphen removed)
          * `description` = if provided, use entry value; otherwise `DNS zone for <dnsName>`
          * `visibility` = Optional. Default to public. If `private` provided, throw an error stating that private DNS zones are not yet supported (reserved for future use)
          * `labels` = pass merged labels (same labels passed to the internal `Project` module) to the `dns-zone` module `labels` parameter
  * `labels` is optional
    * Apply [CONV-LABELS]. Merge order (later wins): user labels → service-project default `{ environment: "<environment>" }` → parent `Project` module defaults `{ module: "project", deployed_by: "pulumi" }`. Service Project merges its `{ environment }` default, then passes the result to the internal `Project` module, which applies its own defaults.
    * Note: the `environment` label is always set by the module and cannot be overridden by user input.
* Return
  * projectDisplayName — `pulumi.Output<string>` — the project display name
  * projectId — `pulumi.Output<string>` — the `<name>-<environment>-<postfix>` string
  * projectNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * environment — `pulumi.Output<string>` — the environment name
  * bindingsPowerUser — `pulumi.Output<ServiceProjectPowerUser | null>` — as inputted, null if not provided
    * `ServiceProjectPowerUser`: `{ group: string; sa: { enabled: boolean; name?: string } | undefined; bindings: string[]; bindingProjectIAM?: string[] }`
  * bindingsROUser — `pulumi.Output<ServiceProjectROUser | null>` — as inputted, null if not provided
    * `ServiceProjectROUser`: `{ group: string; bindings: string[] }`
  * powerUserServiceAccountEmail — `pulumi.Output<string | null>` — SA email if created, null otherwise
  * stateBucketName — `pulumi.Output<string | null>` — final bucket name, null if `stateBucket` is false
  * zones — `pulumi.Output<{ zoneName: string; dnsName: string }[] | null>` — array of all created zones (publicDefault + additional), null if `projectZones` is not provided
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults
