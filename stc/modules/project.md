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
orgPolicyOverride: # (optional)
  <policy constraint name>:
    spec: <policy spec (optional, at least one of spec or dryRunSpec required)>
    dryRunSpec: <dry run policy spec (optional, at least one of spec or dryRunSpec required)>
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
  * `orgPolicyOverride` (optional)
    * Iterate over map entries where the key is the policy constraint name and the value contains `spec` and/or `dryRunSpec`
    * Validation is performed up-front in the Project module before delegating to the org-policy module: key (policy name) must be non-empty, at least one of `spec` or `dryRunSpec` must be provided
    * For each entry:
      * Pulumi resource name: `${name}-orgpolicy-${policyName}`
      * Create policy via org-policy module with:
        * `project` = Project ID (`pulumi.Output<string>` from the created project — org-policy module accepts `pulumi.Input<string>`)
        * `policyName` = map key
        * `spec` = entry `spec` (if provided) — uses `gcp.orgpolicy.PolicySpec` type, passed through
        * `dryRunSpec` = entry `dryRunSpec` (if provided) — uses `gcp.orgpolicy.PolicyDryRunSpec` type, passed through

  * `labels` is optional
    * Apply [CONV-LABELS] with module defaults: `{ module: "project", deployed_by: "pulumi" }`
* Return
  * projectDisplayName — `pulumi.Output<string>` — the project display name
  * projectId — `pulumi.Output<string>` — the `<name>-<postfix>` string
  * projectNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * bindings — `pulumi.Output<{ [roleId: string]: string[] } | null>` — as inputted, null if not provided
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults
