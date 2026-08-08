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

## Conventions

Reusable rules referenced throughout by tag. Apply wherever referenced.

* **[CONV-INPUT]** — Fields that may receive Outputs from other resources must use `pulumi.Input<string>` (or `pulumi.Input<string>[]` for arrays). Construction-time validation is skipped for unresolved Outputs.
* **[CONV-EXCLUSIVE]** — Exactly one of the listed target fields must be provided. Error if more than one is provided OR none are provided.
* **[CONV-VALIDATE-API]** — Format/existence validation deferred to GCP API at apply time. Only syntax-level checks at construction time.
* **[CONV-POSTFIX]** — A 4-character lowercase hexadecimal postfix (`0-9a-f`). Use `@pulumi/random` `RandomId` with `byteLength: 2`. Access via `.hex` (NOT `.dec` or `.b64Std`). Must NOT regenerate once created — use `keepers` tied to the resource name for stability.
* **[CONV-LABELS]** — Label validation at construction time: keys must match `^[a-z][a-z0-9_-]*$`, values must match `^[a-z0-9_-]*$`, both max 63 chars. Error with descriptive message if invalid. The `labels` arg receives pre-merged labels from the calling stack. Module merges with its own defaults (module defaults win on key collision).

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
  - name: <environment name a>
    bindings: # (optional) - IAM bindings applied to this environment's folder
      <role_id_a>:
        - <principal a>
        - <principal b>
      <role_id_b>:
        - <principal a>
        - <principal c>
  - name: <environment name b>
bindingsOrgAdmin:
  group: <email of an org wide admin group email in Google Identity>
  sa: # (optional)
    enabled: <[true|false]>
    name: <service account name (optional defaults to cicd-org)>
  bindings:
    - <role_id_a>
    - <role_id_b>
apisAdditional: # (optional)
  - <additional apis>
orgPolicyDisableIAMExternalOrg: <[true|false] defaults to true> # (optional)
orgPolicyDisableServiceAccountKeyCreation: <[true|false] defaults to true> # (optional)
orgPolicyAdditional: # (optional)
  <policy constraint name>:
    spec: <policy spec (optional, at least one of spec or dryRunSpec required)>
    dryRunSpec: <dry run policy spec (optional, at least one of spec or dryRunSpec required)>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Create folders
    * Use `folder` module
    * Create under organisation
      * common
        * Name hardcoded to `common`
        * No IAM bindings applied (asymmetric by design — `common` never accepts bindings)
      * environments
        * Parsed type: `Array<{ name: string; bindings?: { [roleId: string]: string[] } }>`
        * One folder per entry under `environments`
        * At least one environment entry must be declared. Error if `environments` is empty or missing.
        * Each entry `name` must be non-empty and unique across the list. Folder display-name length (3–30) deferred to the `folder` module.
        * Folder display name = `name`; Pulumi resource name = `env-<name>`
        * bindings (optional)
          * If provided, pass the entry's `bindings` to the `folder` module for that environment's folder (target = created folder numeric ID)
  * Create seed project
    * Use `project` module
    * Create under `common` folder
    * Assign to `billing` account
    * Name `seed`
    * APIs - Hardcoded
      * cloudresourcemanager.googleapis.com
      * cloudbilling.googleapis.com
      * iam.googleapis.com
      * orgpolicy.googleapis.com (required so the seed project can serve as the quota project for org policy API calls)
    * APIs - Additional
      * APIs `apisAdditional`
    * No IAM Bindings
  * Create org policies
    * Use `org-policy` module
    * Quota project (required for org policy API calls)
      * Under user Application Default Credentials, `orgpolicy.googleapis.com` requires a quota project (else `Error 403: ... requires a quota project`). Use the seed project as the quota/billing project:
        * Create a dedicated `gcp.Provider` (e.g. `seed-quota`) with `userProjectOverride: true` and `billingProject` = seed project ID, gated on `dependsOn: [seedProject]`
        * `orgpolicy.googleapis.com` must be enabled on the seed project (see seed project hardcoded APIs)
        * Pass this provider to the org-policy component via the `providers` (plural) option — the singular `provider` option is NOT inherited by a `ComponentResource`'s children. Also add `dependsOn: [seedProject]`
        * Consequence: org policies must be created AFTER the seed project (and its enabled APIs), not before
    * `orgPolicyDisableIAMExternalOrg` (optional, defaults to `true`)
      * If `true` or not provided:
        * Create `iam.managed.allowedPolicyMembers` policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = `iam.managed.allowedPolicyMembers`
          * `spec`:
            * NOTE: `iam.managed.allowedPolicyMembers` is a **managed constraint**. Managed constraints are configured via `enforce` + a JSON `parameters` blob — NOT classic list-constraint `values`/`allowedValues`. Setting `values` (or combining `allowAll` with `values`) fails with `Error 400: Policy and Constraint must be of the same type` (and `allowAll`+`values` also violates the rule `kind` oneof).
            ```ts
            {
              rules: [{
                enforce: "TRUE",
                parameters: JSON.stringify({
                  allowedPrincipalSets: [`//cloudresourcemanager.googleapis.com/organizations/${organisation}`],
                }),
              }],
            }
            ```
      * If `false`:
        * Do not create the `iam.managed.allowedPolicyMembers` policy
    * `orgPolicyDisableServiceAccountKeyCreation` (optional, defaults to `true`)
      * If `true` or not provided
        * Create `iam.managed.disableServiceAccountKeyCreation` policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = `iam.managed.disableServiceAccountKeyCreation`
          * `spec`:
            * NOTE: `iam.managed.disableServiceAccountKeyCreation` is a **managed boolean constraint**. It is enforced with a single `enforce: "TRUE"` rule and takes NO `parameters` blob (unlike `iam.managed.allowedPolicyMembers`).
            ```ts
            {
              rules: [{
                enforce: "TRUE",
              }],
            }
            ```
      * If `false`:
        * Do not create the `iam.managed.disableServiceAccountKeyCreation` policy
    * `orgPolicyAdditional` (optional)
      * Iterate over map entries where the key is the policy constraint name and the value contains `spec` and/or `dryRunSpec`
      * For each entry:
        * Validation: key (policy name) must be non-empty, at least one of `spec` or `dryRunSpec` must be provided
        * Where map key equals `iam.managed.allowedPolicyMembers`:
          * If `orgPolicyDisableIAMExternalOrg` is `true` (or not provided): do not create a separate policy resource. Instead, merge the entry's additional principal sets into the default policy's `parameters.allowedPrincipalSets` array before creating the single policy resource.
          * If `orgPolicyDisableIAMExternalOrg` is `false`: create the policy using only the additional entry's spec (no default values merged).
        * Where map key equals `iam.managed.disableServiceAccountKeyCreation`:
          * This is a boolean constraint with no list to merge, so the additional entry overrides the flag-created default.
          * If `orgPolicyDisableServiceAccountKeyCreation` is `true` (or not provided): do not create a separate policy resource. Instead, create the single policy resource using the additional entry's `spec`/`dryRunSpec` in place of the default `{ rules: [{ enforce: "TRUE" }] }` spec.
          * If `orgPolicyDisableServiceAccountKeyCreation` is `false`: create the policy using only the additional entry's spec (no default enforcement applied).
        * Otherwise, create policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = map key
          * `spec` = entry `spec` (if provided) — uses `gcp.orgpolicy.PolicySpec` type, passed through
          * `dryRunSpec` = entry `dryRunSpec` (if provided) — uses `gcp.orgpolicy.PolicyDryRunSpec` type, passed through
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
  * OrgPolicies (list of policy names applied, null if none)

### Identity

<!-- This stack is flaky and prone to error due the way authentication works. A few attempts may be required to build it correctly -->

Create a Pulumi stack under `stacks/identity` to create users and groups

* Use `@pulumi/gcp`, `@pulumi/googleworkspace`, `@pulumi/random`, `@pulumi/pulumi`
* Dependencies (`package.json`):
  * `@pulumi/pulumi`: `^3`
  * `@pulumi/gcp`: `^7`
  * `@pulumi/random`: `^4`
  * `@pulumi/googleworkspace`: `file:sdks/googleworkspace` (local SDK — generated via `pulumi package add terraform-provider hashicorp/googleworkspace`, run from the stack directory)
* Structure
  * `createUsers(config, provider)` — creates all Google Workspace users, returns map of created user resources
  * `createGroups(config, provider, users)` — creates groups and assigns memberships (depends on users)
* Accept an input based on the following YAML definition

```yaml
identity:domain: <domain name for google identity>
identity:customerId: <Google Workspace customer ID (starts with C)>
identity:impersonateAdmin: <admin email for domain-wide delegation>
identity:serviceAccountEmail: <service account email from organisation stack>
identity:principals:
  groups:
    - name: <name>
      description: <description of group (optional)>
      users:
        - emailPrimaryId: <user primary email, ID only, part of Google Identity>
      groups: # group principals to add as members (single-level only — referenced groups must not themselves nest further groups created in this stack)
        - emailPrimaryId: <group email ID, maps to a group name in this list or a pre-existing Google Cloud Identity group>
  users:
    - firstName: <first name>
      lastName: <last name>
      emailPrimaryId: <user primary email, ID only, part of Google Identity>
      emailSecondary: <user secondary email, full email address (optional)>
      phoneNumber: <phone number (optional)>
      organisationalUnit: <organisational unit (optional, defaults to /)>
```

* Authentication
  * Uses a service account with domain-wide delegation (created by the Organisation stack)
  * **Manual prerequisites** (performed once before this stack can run):
    1. In **GCP Console** → IAM & Admin → Service Accounts → select the SA created by the Organisation stack
       * Copy the **Unique ID** (numeric) — this is the OAuth Client ID
    2. In **Google Admin Console** → Security → Access and data control → API Controls → Domain-wide Delegation
       * Click "Add new" → paste the Client ID from step 1
       * Add the following OAuth scopes:
         * `https://www.googleapis.com/auth/cloud-platform` 
         * `https://www.googleapis.com/auth/admin.directory.user`
         * `https://www.googleapis.com/auth/admin.directory.group`
         * `https://www.googleapis.com/auth/admin.directory.group.member`
    3. Identify a **super admin user** in Google Workspace who has logged in at least once and accepted the Terms of Service — this is the `impersonateAdmin`
    4. Obtain the **Customer ID** from Google Admin Console → Account → Account Settings
    5. Grant the calling principal (whoever runs `pulumi up`) the `Service Account Token Creator` role on the domain-delegated SA
  * **Credential flow** (within this stack, no separate stack required):
    1. Define the Admin Directory OAuth scopes as a constant array:
       * `https://www.googleapis.com/auth/admin.directory.user`
       * `https://www.googleapis.com/auth/admin.directory.group`
       * `https://www.googleapis.com/auth/admin.directory.group.member`
    2. Mint a fresh SA access token at runtime using `gcp.serviceaccount.getAccountAccessTokenOutput`:
       * `targetServiceAccount` = `serviceAccountEmail` from config
       * `scopes` = `["https://www.googleapis.com/auth/cloud-platform", ...oauthScopes]` — `cloud-platform` is required for the provider to call `IAMCredentials.SignJwt` for DWD
    3. Pass the minted `accessToken` and `serviceAccount` email to the provider
    > **NOTE — Why not `impersonated_service_account` credentials?**
    > The `impersonated_service_account` credential type (supported by `golang.org/x/oauth2/google`) cannot perform domain-wide delegation with the Google Workspace provider. The provider's DWD flow requires `JWTConfigFromJSON`, which expects a `service_account` type with a private key for local JWT signing. `impersonated_service_account` has no private key, so the provider silently falls back to a non-DWD flow, resulting in 403 errors.
    >
    > **Limitation of the `accessToken` approach:** The short-lived token (~1 hour) is stored in Pulumi state. On subsequent runs with `--refresh`, Pulumi reinitializes the provider using the stale token from state before the program can mint a fresh one, causing `ACCESS_TOKEN_EXPIRED` errors. **Do NOT use `--refresh` with this stack.** The Makefile omits `--refresh` for this reason.
  * **Provider configuration:**
    * Instantiate a `google-workspace` provider with:
      * `customerId` — from config
      * `impersonatedUserEmail` — from config (`impersonateAdmin`)
      * `accessToken` — the freshly minted SA access token from step 2
      * `serviceAccount` — `serviceAccountEmail` from config (enables DWD via `SignJwt`)
      * `oauthScopes` — the Admin Directory scopes from step 1
    * All Google Workspace resources must use this explicit provider instance
  * **Config inputs for authentication:**
    * `identity:customerId` — Google Workspace customer ID (starts with `C`)
    * `identity:impersonateAdmin` — super admin email for user impersonation
    * `identity:serviceAccountEmail` — SA email from Organisation stack
* Validation
  * `domain` must be provided and non-empty
  * `customerId` must be provided and start with `C`
  * `impersonateAdmin` must be provided and contain `@`
  * `serviceAccountEmail` must be provided and contain `@`
  * At least one of `principals.users` or `principals.groups` must be non-empty
  * Each user entry must have `firstName`, `lastName`, and `emailPrimaryId` (all non-empty)
  * Each group entry must have `name` and at least one member — either in `users` or `groups` (or both). `description` is optional.
  * `emailPrimaryId` must not contain `@` (it is the ID-only portion, domain is appended automatically)
  * `groups[].groups[]` entries may reference group `name` values defined in `principals.groups` (created in same run) or pre-existing Google Cloud Identity groups. They must not contain `@`.
* Resource Naming
  * User resources: `user-<emailPrimaryId>` (e.g. `user-jdoe`)
  * Group resources: `group-<name>` (e.g. `group-pulumi-admins`)
  * Group member resources: `group-<name>-member-<emailPrimaryId>` (e.g. `group-pulumi-admins-member-jdoe`)
  * Password resources: `password-<emailPrimaryId>` (e.g. `password-jdoe`)
* Requirements
  * Create Identity Users
    * `primaryEmail` = `<emailPrimaryId>@<domain>` (concatenate the ID-only value with the config domain)
    * `name.givenName` = `firstName`
    * `name.familyName` = `lastName`
    * `recoveryEmail` = `emailSecondary` (if provided)
    * `recoveryPhone` = `phoneNumber` (if provided)
    * `orgUnitPath` = `organisationalUnit` (if provided, defaults to `/`)
    * Password generation:
      * Use `@pulumi/random` `RandomPassword` with `length: 16`, `special: true`
      * Use `keepers` tied to `emailPrimaryId` to ensure the password is stable across re-runs (only regenerated if the user identity changes)
      * Mark as `pulumi.secret()` — must not appear in plaintext in state or outputs
      * Set `changePasswordAtNextLogin: true` on the user resource
  * Create Identity Groups
    * Nesting is single-level only — a group's `groups[]` entries must not themselves have `groups[]` members created in this stack.
    * To handle dependencies, build two group lists:
      * List one: groups whose `name` appears in another group's `groups[]` array — create these groups first (they are depended upon)
      * List two: groups whose `name` does NOT appear in any other group's `groups[]` array — create these groups after, with explicit `dependsOn` on any groups from list one that they reference in their own `groups[]`
    * `email` = `<name>@<domain>` (concatenate group name with the config domain)
    * `description` = `description`
    * Assign each `emailPrimaryId` under `groups[].groups` as a `GROUP` member of the group:
      * Construct member email as `<emailPrimaryId>@<domain>`
      * Set member `type` to `GROUP`
      * Groups may reference entries defined in `principals.groups` (created in same run) or pre-existing Google Cloud Identity groups
      * Add explicit `dependsOn` on the corresponding group resource (if created in this stack) to ensure ordering
    * Assign each `emailPrimaryId` under `groups[].users` to the group:
      * Construct member email as `<emailPrimaryId>@<domain>`
      * Users may reference entries defined in `principals.users` (created in same run) or pre-existing Google Workspace users
      * Add explicit `dependsOn` on the corresponding user resource (if created in this stack) to ensure ordering
      * Rely on API error if the user does not exist
* Return
  * users — map of `<emailPrimaryId>: <full primary email>` for all created users
  * groups — map of `<group name>: <group email>` for all created groups

### Project Factory

Create a Pulumi stack under `stacks/project-factory` to create service projects

* Use `@pulumi/gcp`, `@pulumi/pulumi`, `@pulumi/random`, `js-yaml`
* Dependencies (`package.json`):
  * `@pulumi/pulumi`
  * `@pulumi/gcp`
  * `@pulumi/random` (required by project and storage modules)
  * `js-yaml` (for parsing initiative-common and org-common YAML files)
  * `@types/js-yaml` (devDependency)
* Stack input
  * Accept an input based on the following YAML definition
    * Multiple yaml definitions permitted
      * Each yaml is a separate pulumi stack. Each yaml is a native Pulumi stack config file — keys are namespaced under `config:` with the `project-factory:` prefix (e.g. `config: { project-factory:<env-parameter-key>: <env-parameter-value> }`)
      * Each yaml represents a single service project
      * Each yaml must follow the following format to identify the initiative the project is for and the environment the project belongs to
        * `Pulumi.<initiative>-<environment>.yaml`
        * Environment is determined from filename, hence it not provided as a parameter in the yaml file
    * Where a setting is labelled as follows
      * `# (optional - takes priority over initiative common file definition if defined)`
      * It will take priority over corresponding settings in Common yaml definition specified below stack yaml definition

```yaml
bindingsPowerUserConfig: # (optional - takes priority over initiative common file definition if defined)
  sa: # (optional)
    enabled: <[true|false]>
    name: <service account name (optional defaults to cicd-<name>)>
  bindings:
    - <role_id_a>
    - <role_id_b>
  bindingProjectIAM: # (optional)
    - <role_id_a>
bindingsPowerUserPrincipal: <group: prefixed email of a power-user group in Google Identity> # (Required where bindingsPowerUserConfig provided)
bindingsROUserConfig: # (optional - takes priority over initiative common file definition if defined)
  bindings:
    - <role_id_a>
    - <role_id_b>
bindingsROUserPrincipal: <group: prefixed email of a read-only-user group in Google Identity> # (Required where bindingsROUserConfig provided)
stateBucket: <[true|false] defaults to true> # (optional - takes priority over initiative common file definition if defined)
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Initiative common input
  * Read a initiative common file with the following YAML definition
    * Filename referenced by naming convention of stack yaml
    * Multiple yaml definitions permitted
      * One per initiative. Common across environments
      * Each yaml must follow the following format to identify the initiative it is for
        * `Pulumi.<initiative>-common.yaml`
    * Where a setting is labelled as follows
      * `# (optional - overridable at the stack level)`
      * If it is also defined at the stack level, stack level takes priority

```yaml
name: <project name base (combined with environment to form the display name and project ID base)>
apis: # (optional)
  - <one API>
bindingsPowerUserConfig: # (optional - overridable at the stack level)
  sa: # (optional)
    enabled: <[true|false]>
    name: <service account name (optional defaults to cicd-<name>)>
  bindings:
    - <role_id_a>
    - <role_id_b>
  bindingProjectIAM: # (optional)
    - <role_id_a>
bindingsROUserConfig: # (optional - overridable at the stack level)
  bindings:
    - <role_id_a>
    - <role_id_b>
stateBucket: <[true|false] defaults to true> # (optional - overridable at the stack level)
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Organisation common input
  * Read a organisation common file with the following YAML definition
    * Single yaml file permitted. Must follow the following format
      * `Pulumi-common.yaml`

```yaml
organisation: <organisation numeric ID> # used to scope the environment-folder lookup (NOT the project parent — parent is always the environment folder)
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
seedProjectID: <seed project ID>
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

<!--FUTURE ENHANCEMENT. EVENTUALLY ALL PARAMETERS AT THE ORG OR INITIATIVE LEVEL WILL BE OVERRIDABLE AT THE STACK YAML FILE LEVEL. FOR NOW, ONLY FOR IAM RELATED SETTINGS AND stateBucket-->

* Config Resolution
  * Stack config (env-level): read via `new pulumi.Config("project-factory")` — Pulumi natively loads `Pulumi.<initiative>-<environment>.yaml` as the active stack config
  * Initiative-common and org-common files are NOT Pulumi stack configs — they are parsed manually at runtime:
    * Use `js-yaml` to parse YAML files
    * Files are located in the stack directory (same directory as `index.ts`)
    * Read paths: `path.join(__dirname, \`Pulumi.${initiative}-common.yaml\`)` and `path.join(__dirname, "Pulumi-common.yaml")`
    * NOTE: `Pulumi-common.yaml` is NOT the Pulumi project file (`Pulumi.yaml`). `Pulumi.yaml` is the standard Pulumi project definition (`name: project-factory`, `runtime: nodejs`). `Pulumi-common.yaml` is a custom file read at runtime for org-wide config.
  * Merge priority (later wins on key collision): org-common → initiative-common → stack config (env-level)
  * Extract `initiative` and `environment` from the Pulumi stack name via `pulumi.getStack()` — split on the **last** hyphen (e.g. `my-app-dev` → initiative=`my-app`, environment=`dev`)
* Makefile
  * The existing `Makefile` handles this stack via `STACK_DIR=stacks/project-factory` and `STACK_ENV=<initiative>-<environment>` (which sets `PULUMI_STACK`). Example: `make up-infra STACK_DIR=stacks/project-factory STACK_ENV=myapp-dev`
* Requirements
  * Validate and Load Parameters
    * Extract `initiative` and `environment` from the Pulumi stack name (see Config Resolution above)
    * Stack name must contain at least one hyphen; both `initiative` and `environment` must be non-empty after splitting. Error if not.
    * `<environment>` must not = `org` or `common`. Error if value provided.
    * Read `Pulumi.<initiative>-common.yaml`. Error if not found
    * Read `Pulumi-common.yaml`. Error if not found
    * `bindingsPowerUserConfig` may be defined in `Pulumi.<initiative>-<env>.yaml` or `Pulumi.<initiative>-common.yaml`
      * Where defined in both files, prioritise `Pulumi.<initiative>-<env>.yaml` and throw warning
      * `bindingsPowerUserPrincipal` is always read from the env-level Pulumi stack config (never from initiative-common or org-common). Required if `bindingsPowerUserConfig` is provided (in either file). Error if missing.
    * `bindingsROUserConfig` may be defined in `Pulumi.<initiative>-<env>.yaml` or `Pulumi.<initiative>-common.yaml`
      * Where defined in both files, prioritise `Pulumi.<initiative>-<env>.yaml` and throw warning
      * `bindingsROUserPrincipal` is always read from the env-level Pulumi stack config (never from initiative-common or org-common). Required if `bindingsROUserConfig` is provided (in either file). Error if missing.
    * `stateBucket` may be defined in `Pulumi.<initiative>-<env>.yaml` or `Pulumi.<initiative>-common.yaml`
      * Where defined in both files, prioritise `Pulumi.<initiative>-<env>.yaml` and throw warning
      * Defaults to `true` if not defined in either file
  * Create single project
    * Use `service-project` module
    * For the following parameters, do not perform additional validation or error handling. Underlying module will handle this
      * `organisation` = `organisation`
      * `billing` = `billing`
      * `environment` = `environment`
      * `seedProjectID` = `seedProjectID`
      * `name` = `name`
      * `defaultLocation` = `defaultLocation`
      * `apis` = `apis`
      * `bindingsPowerUser.group` = `bindingsPowerUserPrincipal`
      * `bindingsPowerUser.sa` = `bindingsPowerUserConfig.sa`
      * `bindingsPowerUser.bindings` = `bindingsPowerUserConfig.bindings`
      * `bindingsPowerUser.bindingProjectIAM` = `bindingsPowerUserConfig.bindingProjectIAM`
      * `bindingsROUser.group` = `bindingsROUserPrincipal`
      * `bindingsROUser.bindings` = `bindingsROUserConfig.bindings`
      * `stateBucket` = `stateBucket`
    * `labels` is optional for all yaml files
      * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
      * Merge order (later wins on key collision): sanitised user org labels → sanitised user initiative labels → sanitised user env labels → stack hardcoded labels (`{ stack: "project-factory", initiative: "<initiative>", environment: "<environment>" }`) → module-level defaults
      * The merged result (still a plain object at this point — `apply()` the Labels output then spread with hardcoded labels) is passed to modules
    * Project module `labels` arg must accept `pulumi.Input<{ [key: string]: string }>` to support receiving Outputs
* Return
  * projectDisplayName — the project display name
  * projectId — the `<name>-<environment>-<postfix>` string
  * projectNumber — GCP-assigned numeric project identifier
  * environment — the environment name
  * powerUserServiceAccountEmail (if SA enabled, null if not)
  * stateBucketName (final bucket name, null if stateBucket is false)
  * labels — final merged map including module defaults

## Modules

* Use `@pulumi/gcp`, `@pulumi/pulumi` at minimum. Modules may require additional libraries (e.g. `@pulumi/random`) — these must be documented in the module STC and included in the calling stack's `package.json`.
* Pulumi
  * `package.json` to be defined in calling stack. Implement code only
* All modules are to be `pulumi.ComponentResource` modules, not native methods / functions
  * Structure should be `modules/<module name>/index.ts`
  * The ComponentResource input interface must be named `<ModuleName>Args` (e.g. `IamArgs`)
  * The ComponentResource type string must follow `custom:modules:<ModuleName>` (e.g. `custom:modules:Iam`)
* Where a YAML definition is provided use as a guide, but input should be a method / function object as it will be called by an underlying stack
* Modules are consumed by stacks via relative import and are not deployed independently. No Makefile target required.
* Validation
  * Syntax-level validation only at construction time — verify format and required fields are present. Do not verify resource existence; defer to GCP APIs at apply time.
  * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
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

```yaml
organisation: <organisation numeric ID (mutually exclusive)>
folder: <folder numeric ID (mutually exclusive)>
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
conditions: # (optional)
  - role: <role_id (must match a role in bindings)>
    title: <condition title (required, validated client-side)>
    description: <description (optional)>
    expression: <CEL expression (required, validated by API)>
    members:
      - <principal (must match a member assigned to the role in bindings)>
```

* Requirements
  * Input Types
    * Target fields (`organisation`, `folder`, `project`) and `resource.identifier`: [CONV-INPUT]
    * Target: exactly one of `organisation`, `folder`, `project`, `resource` must be provided [CONV-EXCLUSIVE]
      * All target values are passed as-is to the GCP provider (no prefix prepending required)
    * For `resource`
      * `type` must be provided
        * Supported values: `storage`, `service_account`
        * If anything else, error with message: `"Unsupported resource type '<type>'. Must be one of: storage, service_account"`
      * `identifier` must be provided (non-empty). [CONV-VALIDATE-API]
    * `bindings` must be provided with at least one role entry
      * `<role_id>` format: [CONV-VALIDATE-API]
      * Each role must have at least one principal
      * Principal must start with one of: `user:`, `group:`, `serviceAccount:`, `domain:`
      * `bindings` principal arrays: [CONV-INPUT] (e.g. service account emails constructed via `pulumi.interpolate`)
    * `conditions` is optional. Where provided, each entry must contain:
      * `role` must be provided and match a role defined in `bindings`
      * `title` must be provided and validated client-side: must be non-empty, max 100 characters, must match `^[a-zA-Z0-9_. -]+$`
      * `description` is optional
      * `expression` must be provided (CEL expression). [CONV-VALIDATE-API]
      * `members` must be provided as a non-empty list. Each member must match a principal assigned to the corresponding role in `bindings`
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
  * bindings — `pulumi.Output<{ [roleId: string]: string[] }>` — the role-to-principal mapping (principals resolved at apply time)

### Org Policy

Create a Pulumi module under `modules/org-policy` to manage organisation policies

* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID (mutually exclusive)>
folder: <folder numeric ID (mutually exclusive)>
project: <project ID (mutually exclusive)>
policyName: <policy name>
spec: <policy specifications (optional, at least one of spec or dryRunSpec required)>
dryRunSpec: <policy specifications (optional, at least one of spec or dryRunSpec required)>
```

* Requirements
  * Input Types
    * Target fields (`organisation`, `folder`, `project`): [CONV-INPUT]
    * Target: exactly one of `organisation`, `folder`, `project` must be provided [CONV-EXCLUSIVE]
      * Input is the numeric/string ID. Module must prepend `organizations/`, `folders/`, or `projects/` as required by the GCP API.
    * `policyName` must be provided and non-empty. [CONV-VALIDATE-API]
    * At least one of `spec` or `dryRunSpec` must be provided. Both may be supplied simultaneously (`spec` is the enforced policy, `dryRunSpec` is for audit-mode testing).
  * `spec` and `dryRunSpec` accept the `gcp.orgpolicy.PolicySpec` type directly. Pass through without transformation.
  * Use `gcp.orgpolicy.Policy` pulumi resource
  * Child resource name: `<component-name>-policy`
  * Construct policy name and parent ID:
    * For `organisation`
      * Name `organizations/<organization>/policies/<policy_name>`
      * Parent `organizations/<organization_id>`
    * For `folder`
      * Name `folders/<folder>/policies/<policy_name>`
      * Parent `folders/<folder>`
    * For `project`
      * Name `projects/<project>/policies/<policy_name>`
      * Parent `projects/<project>`
* Return
  * policyName — `pulumi.Output<string>` — the policy constraint name
  * parent — `pulumi.Output<string>` — the target (organisation, folder, or project ID)
  * spec — `pulumi.Output<gcp.orgpolicy.PolicySpec | null>` — as passed, null if not provided
  * dryRunSpec — `pulumi.Output<gcp.orgpolicy.PolicyDryRunSpec | null>` — as passed, null if not provided


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
    * `project`, `name`: [CONV-INPUT]. Construction-time name validation is skipped for unresolved Outputs (only resolved plain strings are validated).
  * `name` must be provided
    * Must be 3–63 characters (or 3–58 if `postfix` is true, reserving 5 characters for `-<postfix>`)
    * Allowed characters: lowercase letters, digits, hyphens, underscores, dots
    * Must start and end with a lowercase letter or digit
    * Must not contain the prefix `goog` or the string `google`
    * Error with descriptive message if validation fails
  * `postfix` is optional. Must be true or false. Default to false
    * Where true:
      * Apply [CONV-POSTFIX] with `keepers` tied to the bucket `name`
      * The postfix is appended to the bucket name `<name>-<postfix>`. Cater for this with name validation
  * `project` must be provided. Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number
  * Exactly one of `location`, `location_dual`, or `location_multi` must be provided [CONV-EXCLUSIVE]
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
    * Apply [CONV-LABELS] with module defaults: `{ module: "storage", deployed_by: "pulumi" }`
* Return
  * bucketName — `pulumi.Output<string>` — final name, including postfix if applicable
  * location — `pulumi.Output<string>` — the resolved bucket location
  * uniformAccess — `pulumi.Output<boolean>` — whether uniform bucket-level access is enabled
  * versioning — `pulumi.Output<boolean>` — whether object versioning is enabled
  * bindings — `pulumi.Output<{ [roleId: string]: string[] } | null>` — as inputted, null if not provided
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults

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
    * `organisation`, `folder`: [CONV-INPUT]
  * `name` must be provided
    * Validate display name is between 3 and 30 characters. Error if not met.
  * Exactly one of `organisation`, `folder` [CONV-EXCLUSIVE]
    * Input is the numeric ID. Module must prepend `organizations/` or `folders/` as required by the GCP API.
    * For `organisation`
      * Create folder under provided organisation
    * For `folder`
      * Create folder under provided parent folder
  * `bindings` is optional. Principal arrays: [CONV-INPUT].
    * If bindings is provided
      * Use the `iam` module
      * Inputs
        * folder = created folder's numeric ID
        * bindings = bindings
* Return
  * folderId — `pulumi.Output<string>` — the GCP-assigned folder numeric ID
  * displayName — `pulumi.Output<string>` — the folder display name
  * bindings — `pulumi.Output<{ [roleId: string]: string[] } | null>` — as inputted, null if not provided

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
    * `organisation`, `folder`, `billing`: [CONV-INPUT]
  * `name` must be provided
    * Validate input `name` first: must be lowercase letters, digits, and hyphens only, must start with a letter, cannot end with a hyphen, and must be between 1–25 characters (reserving 5 characters for `-<postfix>`)
    * The final project ID (`<name>-<postfix>`) will be 6–30 characters and must meet GCP project ID restrictions
  * Naming convention as follows
    * `<name>-<postfix>`
      * Apply [CONV-POSTFIX] with `keepers` tied to the project `name`
  * Exactly one of `organisation`, `folder` [CONV-EXCLUSIVE]
    * Input is the numeric ID. Module must prepend `organizations/` or `folders/` as required by the GCP API.
    * For `organisation`
      * Create project under provided organisation
    * For `folder`
      * Create project under provided parent folder
  * `billing` must be provided
    * [CONV-VALIDATE-API]
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
    * Apply [CONV-LABELS] with module defaults: `{ module: "project", deployed_by: "pulumi" }`
* Return
  * projectDisplayName — `pulumi.Output<string>` — the project display name
  * projectId — `pulumi.Output<string>` — the `<name>-<postfix>` string
  * projectNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * bindings — `pulumi.Output<{ [roleId: string]: string[] } | null>` — as inputted, null if not provided
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults

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
          * `title`: `condition_block_<blockId>` (e.g. `condition_block_0`, `condition_block_1`)
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