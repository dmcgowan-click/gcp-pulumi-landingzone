# Standard Template Constructs

* Use TypeScript
  * TypeScript Configuration
    * `tsconfig.json` must target `ES2020` for both `target` and `lib` options — the bundled ts-node in `@pulumi/pulumi` does not support newer targets (e.g. ES2022)
    * `rootDir` must be set to `../..` (relative to the stack directory) so that modules outside the stack directory are included in compilation
    * `include` must contain `../../modules/**/*.ts` to compile shared modules
* All classes and functions should have details comments in the following format

```ts
/**
 * <description>
 *
 * @param <name> <description>
 * @returns <description>
 */
```

* Pulumi requirements
  * **Never create resources inside `.apply()` callbacks.** Resources created inside `.apply()` cannot be tracked by Pulumi's state engine and will appear as new resources on every `pulumi up`, causing repeated creates/updates. Instead:
    * Use `pulumi.interpolate` to construct string Outputs (e.g. `` pulumi.interpolate`serviceAccount:${sa.email}` ``)
    * Pass `pulumi.Output<string>` values directly to resource arguments that accept `pulumi.Input<string>`
    * Since the majority of inputs to modules come from other created resources (and are therefore Outputs), modules must be designed to accept `pulumi.Input<string>` for any field that might receive a resource output

## Stacks

* Use `@pulumi/gcp`, `@pulumi/pulumi` unless otherwise specified
* Pulumi usage (`pulumi preview`, `pulumi up`)
  * All `stacks` should be executable via the `Makefile` in the root of the working directory
  * The `Makefile` must rsync both the stack directory and the `modules/` directory into the working directory so that relative imports from modules resolve correctly
  * `package.json` must be created based on the `import` blocks in the stack and consumed modules
  * `package-lock.json` does not need to be created, but may be created by the user at their discretion
* Pulumi State Backend
  * If `PULUMI_STATE_BUCKET` is set, login to GCS backend (`pulumi login gs://<bucket>`)
  * If `PULUMI_STATE_BUCKET` is not set, use local state (`pulumi login --local`)
* All stacks are made up of discrete functions which may call modules as defined
  * Example for an organisation stack:
    * `createFolders(...)` — creates the `common` folder and environment folders
    * `createSuperAdminBindings(...)` — creates IAM bindings for the super admin group
  * Structure should be
    * `stacks/<stack name>/index.ts`
    * `stacks/<stack name>/package.json`
  * Module Resolution
    * Modules use relative imports for `@pulumi/*` packages — these resolve via Node's `node_modules` directory walking
    * The `Makefile` `prepare-infra` target must symlink the stack's `node_modules` into the `modules/` directory so that modules can resolve their dependencies: `ln -sfn <stack_node_modules> <modules_dir>/node_modules`
* Where a YAML definition is provided, add it to the `Pulumi.<env>.yaml` file/s alongside any default required values
  * Config values will fall under a config namespace matching the stack name (e.g. `organisation:organisation`, `organisation:environments`)
  * Where existing key / values have been populated, leave values as they are
  * Where new keys with descriptive values have been added, prompt the user for input
* Stack Outputs
  * Use module-level `export const` declarations for stack outputs (e.g. `export const myOutput = value`)
  * Do NOT use `pulumi.export("name", value)` — this is a Python SDK pattern and does not exist in the Node.js SDK

### Organisation

Create a Pulumi stack under `stacks/organisation` to create org level components

* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID>
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
environments:
  - <environment name a>
  - <environment name b>
bindingsOrgAdmin:
  group: <email of an org wide admin group email in Google Identity>
  sa: # (optional)
    enabled: <[true|false]>
    name: <service account name (optional defaults to cicd-org)>
  bindings:
    - <role_id_a>
    - <role_id_b>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Create folders
    * Use `folder` module
    * Create under organisation
      * common
        * Name hardcoded to `common`
        * No IAM bindings applied
      * environments
        * One folder per entry under `environments`
        * At least one environment entry must be declared. Error if `environments` is empty or missing.
  * Create seed project
    * Use `project` module
    * Create under `common` folder
    * Assign to `billing` account
    * Name `seed`
    * APIs
      * cloudresourcemanager.googleapis.com
      * cloudbilling.googleapis.com
      * iam.googleapis.com
    * No IAM Bindings
  * Create bindings for Org Admin Google Identity group
    * Validate that `bindingsOrgAdmin.group` starts with `group:` prefix at construction time. Error if not. Only `group:` principals are accepted for this input.
    * If `bindingsOrgAdmin.sa` is provided
      * `bindingsOrgAdmin.sa.enabled` is required. Must be `true` or `false`.
      * Where `true`
        * Create a service account using `gcp.serviceaccount.Account`
        * Create under seed project
        * Name: `bindingsOrgAdmin.sa.name` if provided, otherwise default to `cicd-org`. Validation deferred to GCP API at apply time.
        * Description: `Service Account for <name>. Org wide bindings`
    * Use `iam` module
      * Assign bindings to the organisation
      * Principals: group + SA (if `sa.enabled` is `true`) — combine into a single IAM call
      * Transform input: for each role in `bindingsOrgAdmin.bindings`, create an entry `{ <role>: [<group>, <serviceAccount:sa-email>] }`
        * Omit SA principal if `sa.enabled` is `false` or `sa` is not provided
  * `labels` is optional
    * Labels only apply to resources that support them (e.g. seed project). Folders do not support labels or tags.
    * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
    * Merge order (after sanitisation, later wins on key collision): sanitised user labels → stack hardcoded labels → module-level defaults
      * Stack merges sanitised output with its own defaults: `{ stack: "organisation" }`
      * The merged result (still a plain object at this point — `apply()` the Labels output then spread with hardcoded labels) is passed to modules
    * Project module `labels` arg must accept `pulumi.Input<{ [key: string]: string }>` to support receiving Outputs
  * Create storage bucket for Pulumi state
    * Use `storage` module
    * Name `pulumi-state-organisation`
    * Postfix `true`
    * Project = seed project ID (output from the Project module)
    * Location = `gcp:region` from Pulumi config (read via `new pulumi.Config("gcp").require("region")`)
    * Use module defaults for `uniformAccess` (`true`) and `versioning` (`true`)
    * Labels = same merged labels as seed project (sanitised user labels → `{ stack: "organisation" }` → module defaults)
* Return
  * Organisation
  * Folders
    * <key = name> = <value = numeric id (gcp assigned)>
    * Bindings (as null if NA)
  * BindingsOrgAdmin
  * ServiceAccountEmail (if SA enabled, null if not)
  * ProjectSeedName
  * ProjectSeedID
  * ProjectSeedNumericIdentifier (GCP-assigned number)
  * StorageBucketName (final bucket name with postfix)

### Identity

Create a Pulumi stack under `stacks/identity` to create users and groups

* Use `@pulumi/google-workspace`
* Based on the `stacks/identity/Pulumi.org.sample.yaml` template
* Authentication
  * TO BE UPDATED
* Requirements
  * Identity Groups
    * Group email should always be `name`@`domain`
    * Ensure users are provisioned first. The `users:` section within `groups:` has a dependency on users
      * If a user does not exist, the stack should fail with a clear error identifying the invalid user and the group it was being added to
        * A user may have been created outside of this stack, we still want to allow them to be added to a group managed under this repo. Use provided username email and rely on API error if username email is invalid
    * Add `:principalOwnerName` as a single group owner
  * Identity Users
    * For `emailPrimaryId:` use `emailPrimaryId`@`domain`
    * Where `(optional)`, do not enforce that these values be provided
    * Randomly generate a password and force reset on initial login

## Modules

* Use `@pulumi/gcp`, `@pulumi/pulumi` at minimum. Modules may require additional libraries (e.g. `@pulumi/random`) — these must be documented in the module STC and included in the calling stack's `package.json`.
* Use TypeScript
* Pulumi
  * `package.json` to be defined in calling stack. Implement code only
* All modules are to be `pulumi.ComponentResource` modules, not native TypeScript modules
  * Structure should be `modules/<module name>/index.ts`
  * The ComponentResource input interface must be named `<ModuleName>Args` (e.g. `IamArgs`)
* Where a YAML definition is provided use as a guide, but input should be a TypeScript object as it will be called by an underlying stack
* Modules are consumed by stacks via relative import and are not deployed independently. No Makefile target required.
* Where module supports labels
  * Merge priority (later wins on key collision): user-provided labels (passed via `labels` arg) → module-level defaults (e.g. `module: "project"`, `deployed_by: "pulumi"`)
  * Calling stacks are responsible for merging stack-level labels before passing to the module

### Labels

Create a Pulumi module under `modules/labels` to sanitise labels into GCP-compliant format (and in future, manage tagging)

* Accept an input based on the following YAML definition

```yaml
labels:
  <key>: <value>
```

* Requirements
  * Input: a flat map of `{ [key: string]: string }` (at least one entry)
  * Implement as a `pulumi.ComponentResource` (`Labels` class, `LabelsArgs` interface, type `custom:modules:Labels`)
  * No additional dependencies beyond `@pulumi/pulumi`
  * Sanitisation rules (applied to both keys and values):
    * Convert all characters to lowercase
    * Replace any character NOT in `[a-z0-9_-]` with `_`
    * For keys only: if the first character is not `[a-z]`, prepend `l_`
    * Truncate to 63 characters maximum
    * If a key is empty after sanitisation, error with descriptive message
* Return
  * `labels` — `pulumi.Output<{ [key: string]: string }>` — the sanitised label map
* Integration
  * Stacks should instantiate `new Labels(...)` and pass `.labels` output to downstream modules
  * Module-level validation (e.g., in Project) remains as a safety net but should not need to reject labels that have been sanitised

### IAM

Create a Pulumi module under `modules/iam` to manage IAM bindings

* Accept an input based on the following YAML definition
  * NOTE: No authoritative option by design. Have never used this option in practice, and accidental usage has caused major problems in the past
  * Use non-authoritative IAM member bindings (`IAMMember` resources) for all target types. Do not use `IAMBinding` or `IAMPolicy`.
  * Do NOT implement IAM conditions. This is out of scope for this version.

```yaml
organisation: <organisation ID (mutually exclusive)>
folder: <folder ID (mutually exclusive)>
project: <project ID (mutually exclusive)>
resource: # (mutually exclusive)
  type: <storage | service_account>
  identifier: <resource identifier>
bindings:
  <role_id_a>:
    - <principal a>
    - <principal b>
  <role_id_b>:
    - <principal a>
    - <principal c>
```

* Requirements
  * Input Types
    * Target fields (`organisation`, `folder`, `project`) and `resource.identifier` must use `pulumi.Input<string>` to support receiving Outputs from other Pulumi resources
    * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
  * Validation
    * Syntax-level validation only at construction time — verify format and required fields are present. Do not verify resource existence; defer to GCP APIs at apply time.
    * Target: exactly one of `organisation`, `folder`, `project`, `resource` must be provided
      * Error if more than one is provided OR none are provided
      * All target values are passed as-is to the GCP provider (no prefix prepending required)
    * For `resource`
      * `type` must be provided
        * Supported values: `storage`, `service_account`
        * If anything else, error with message: `"Unsupported resource type '<type>'. Must be one of: storage, service_account"`
      * `identifier` must be provided (non-empty). Format validation deferred to GCP API at apply time.
    * `bindings` must be provided with at least one role entry
      * `<role_id>` format is not validated client-side; defer to GCP API at apply time
      * Each role must have at least one principal
      * Principal must start with one of: `user:`, `group:`, `serviceAccount:`, `domain:`
  * Resource Naming
    * Child Pulumi resource names must follow `<component-name>-<roleId>-<principal>` with `/` and `:` replaced by `-`
    * When a principal is a `pulumi.Output<string>` (not a plain string), use `member-<index>` in place of the principal value for the resource name (e.g. `<component-name>-<roleId>-member-0`). This ensures deterministic naming without requiring `.apply()` to resolve the value.
* Return
  * organisation (as null if NA)
  * folder (as null if NA)
  * project (as null if NA)
  * resource (as null if NA)
    * type
    * identifier
  * bindings (same format as was inputted)

### Storage

Create a Pulumi module under `modules/storage` to create a storage bucket

* Additional dependencies: `@pulumi/random` (required in the calling stack's `package.json`)
* Accept an input based on the following YAML definition
  * NOTE: User CMK encryption not supported. Default KMS only

```yaml
name: <storage bucket name (3-58 chars if postfix true, else 3-63; lowercase, digits, hyphens, underscores, dots)>
postfix: <[true | false] defaults to false>
project: <project ID string>
location: <valid gcp region (mutually exclusive)>
location_dual: # (mutually exclusive)
  - <region A>
  - <region B>
location_multi: <US | EU | ASIA (mutually exclusive)>
storageClass: <STANDARD | NEARLINE | COLDLINE | ARCHIVE (optional, defaults to STANDARD)>
uniformAccess: <[true | false] defaults to true>
versioning: <[true | false] defaults to true>
bindings: # (optional)
  <role_id_a>:
    - <principal a>
    - <principal b>
  <role_id_b>:
    - <principal a>
    - <principal c>
labels: # (optional) - GCP resource labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Input Types
    * `project` must use `pulumi.Input<string>` to support receiving Outputs from other Pulumi resources
    * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
  * `name` must be provided
    * Must be 3–63 characters (or 3–58 if `postfix` is true, reserving 5 characters for `-<postfix>`)
    * Allowed characters: lowercase letters, digits, hyphens, underscores, dots
    * Must start and end with a lowercase letter or digit
    * Must not contain the prefix `goog` or the string `google`
    * Error with descriptive message if validation fails
  * `postfix` is optional. Must be true or false. Default to false
    * Where true:
      * `postfix` is a 4-character lowercase hexadecimal string (characters `0-9a-f` only)
      * Use `@pulumi/random` `RandomId` with `byteLength: 2` — this produces exactly 4 hex characters
      * Access the hex output via `.hex` (NOT `.dec` or `.b64Std`)
      * The postfix must NOT be regenerated once created — use `keepers` tied to the bucket `name` to ensure stability across re-runs
      * The postfix is appended to the bucket name `<name>-<postfix>`. Cater for this with name validation
  * `project` must be provided. Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number
  * Exactly one of `location`, `location_dual`, or `location_multi` must be provided
    * Error if more than one is provided OR none are provided
    * `location` — a single string representing a valid GCP region (e.g. `australia-southeast1`)
    * `location_dual` — a list of exactly 2 valid GCP regions. Error if not exactly 2 entries are provided
    * `location_multi` — one of `US`, `EU`, or `ASIA` (case-insensitive input, stored uppercase)
  * `storageClass` is optional. Must be one of `STANDARD`, `NEARLINE`, `COLDLINE`, `ARCHIVE`. Default to `STANDARD` if not provided. Error with descriptive message if an unrecognised value is provided
  * `uniformAccess` is optional. Must be true or false. Default to true
    * Where true uniform_bucket_level_access is set to true
  * `versioning` is optional. Must be true or false. Default to true
    * Where true enabled = true
  * `bindings` is optional
    * If bindings is provided
      * Use the `iam` module
      * Inputs
        * resource
          * type = storage
          * identifier = bucket name
        * bindings = bindings
  * `labels` is optional
    * GCP storage buckets support labels (key-value pairs for cost tracking and resource filtering)
    * The `labels` arg receives pre-merged labels from the calling stack
    * Module merges with its own defaults: `{ module: "storage", deployed_by: "pulumi" }` — module defaults win on key collision
    * Label keys/values must be lowercase, max 63 characters, keys must start with a lowercase letter
    * Validate labels at construction time: keys must match `^[a-z][a-z0-9_-]*$`, values must match `^[a-z0-9_-]*$`, both max 63 chars. Error with descriptive message if invalid.
* Return
  * bucketName (final name, including postfix if applicable)
  * location
  * uniformAccess
  * versioning
  * bindings (same format as was inputted, null if not provided)
  * labels (final merged map including module defaults)

### Folder

Create a Pulumi module under `modules/folder` to create a GCP resource folder

* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID (mutually exclusive)>
folder: <parent folder numeric ID (mutually exclusive)>
name: <folder display name>
bindings: # (optional)
  <role_id_a>:
    - <principal a>
    - <principal b>
  <role_id_b>:
    - <principal a>
    - <principal c>
```

* Requirements
  * Input Types
    * `organisation`, `folder` must use `pulumi.Input<string>` to support receiving Outputs from other Pulumi resources
    * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
  * `name` must be provided
    * Validate display name is between 3 and 30 characters. Error if not met.
  * Exactly one of `organisation`, `folder`
    * Error if more than one is provided OR none are provided
    * Input is the numeric ID. Module must prepend `organizations/` or `folders/` as required by the GCP API.
    * For `organisation`
      * Create folder under provided organisation
    * For `folder`
      * Create folder under provided parent folder
  * `bindings` is optional
    * If bindings is provided
      * Use the `iam` module
      * Inputs
        * folder = created folder's numeric ID
        * bindings = bindings
* Return
  * folder numeric ID (GCP-assigned)
  * folder display name
  * bindings (same format as was inputted, null if not provided)

### Project

Create a Pulumi module under `modules/project` to create a GCP project 

* Additional dependencies: `@pulumi/random` (required in the calling stack's `package.json`)
* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID (mutually exclusive)>
folder: <parent folder numeric ID (mutually exclusive)>
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
name: <project name (used as display name and project ID base)>
apis:
  - <one API at minimum>
bindings: # (optional)
  <role_id_a>:
    - <principal a>
    - <principal b>
  <role_id_b>:
    - <principal a>
    - <principal c>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Input Types
    * `organisation`, `folder`, `billing` must use `pulumi.Input<string>` to support receiving Outputs from other Pulumi resources
    * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
  * `name` must be provided
    * Validate input `name` first: must be lowercase letters, digits, and hyphens only, must start with a letter, cannot end with a hyphen, and must be between 1–25 characters (reserving 5 characters for `-<postfix>`)
    * The final project ID (`<name>-<postfix>`) will be 6–30 characters and must meet GCP project ID restrictions
  * Naming convention as follows
    * `<name>-<postfix>`
      * `postfix` is a 4-character lowercase hexadecimal string (characters `0-9a-f` only)
        * Use `@pulumi/random` `RandomId` with `byteLength: 2` — this produces exactly 4 hex characters
        * Access the hex output via `.hex` (NOT `.dec` or `.b64Std`)
        * The postfix must NOT be regenerated once created — use `keepers` tied to the project `name` to ensure stability across re-runs
  * Exactly one of `organisation`, `folder`
    * Error if more than one is provided OR none are provided
    * Input is the numeric ID. Module must prepend `organizations/` or `folders/` as required by the GCP API.
    * For `organisation`
      * Create project under provided organisation
    * For `folder`
      * Create project under provided parent folder
  * `billing` must be provided
    * Validation deferred to GCP API at apply time
    * Assign project to provided billing ID
  * `apis` must contain at least one entry
    * Use `gcp.projects.Service` for each API
    * Set `disableOnDestroy: false` to prevent accidental API disablement on stack teardown
  * Default VPC
    * Set `autoCreateNetwork: false` on the `gcp.projects.Project` resource to prevent creation of the default VPC
  * Default service accounts
    * Use `gcp.projects.DefaultServiceAccounts` to delete all default service accounts (including default compute SA)
    * Must depend on all `gcp.projects.Service` resources — APIs must be enabled first before default SAs can be deleted
    * `compute.googleapis.com` is automatically added to the `apis` list if not already present
  * `bindings` is optional
    * If bindings is provided
      * Use the `iam` module
      * Inputs
        * project = created project ID
        * bindings = bindings
  * `labels` is optional
    * GCP projects support labels (key-value pairs for cost tracking and resource filtering)
    * The `labels` arg receives pre-merged labels from the calling stack
    * Module merges with its own defaults: `{ module: "project", deployed_by: "pulumi" }` — module defaults win on key collision
    * Label keys/values must be lowercase, max 63 characters, keys must start with a lowercase letter
    * Validate labels at construction time: keys must match `^[a-z][a-z0-9_-]*$`, values must match `^[a-z0-9_-]*$`, both max 63 chars. Error with descriptive message if invalid.
* Return
  * project display name
  * project ID (the `<name>-<postfix>` string)
  * project numeric identifier (GCP-assigned number)
  * bindings (same format as was inputted, null if not provided)
  * labels (final merged map including module defaults)