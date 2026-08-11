### Organisation

Create a Pulumi stack under `stacks/organisation` to create org level components

* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID>
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
domain: <google cloud domain>
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
orgPolicyDisableServiceAccountKeyUpload: <[true|false] defaults to true> # (optional)
automaticIamGrantsForDefaultServiceAccounts: <[true|false] defaults to true> # (optional)
orgPolicySkipDefaultNetworkCreation: <[true|false] defaults to true> # (optional)
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
        * Apply domain-wide IAM binding only (asymmetric by design — `common` never accepts user-supplied bindings)
          * Input `{ roles/resourcemanager.folderViewer: [ domain:<domain> ]}`
      * environments
        * Parsed type: `Array<{ name: string; bindings?: { [roleId: string]: string[] } }>`
        * One folder per entry under `environments`
        * At least one environment entry must be declared. Error if `environments` is empty or missing.
        * Each entry `name` must be non-empty and unique across the list. Folder display-name length (3–30) deferred to the `folder` module.
        * Folder display name = `name`; Pulumi resource name = `env-<name>`
        * Apply IAM bindings for domain and (if provided) user-supplied principals
          * Input `{ roles/resourcemanager.folderViewer: [ domain:<domain> ]}`
          * If provided, merge user `bindings` into the domain binding map:
            * For shared role keys, concatenate principal arrays (domain principals + user principals)
            * For new role keys, add as-is
          * Pass merged result to `bindings` in the `folder` module
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
    * `orgPolicyDisableServiceAccountKeyUpload` (optional, defaults to `true`)
      * If `true` or not provided
        * Create `iam.disableServiceAccountKeyUpload` policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = `iam.disableServiceAccountKeyUpload`
          * `spec`: `{ rules: [{ enforce: "TRUE" }] }`
      * If `false`:
        * Do not create the `iam.disableServiceAccountKeyUpload` policy
    * `automaticIamGrantsForDefaultServiceAccounts` (optional, defaults to `true`)
      * If `true` or not provided
        * Create `iam.automaticIamGrantsForDefaultServiceAccounts` policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = `iam.automaticIamGrantsForDefaultServiceAccounts`
          * `spec`: `{ rules: [{ enforce: "TRUE" }] }`
      * If `false`:
        * Do not create the `iam.automaticIamGrantsForDefaultServiceAccounts` policy
    * `orgPolicySkipDefaultNetworkCreation` (optional, defaults to `true`)
      * If `true` or not provided
        * Create `compute.skipDefaultNetworkCreation` policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = `compute.skipDefaultNetworkCreation`
          * `spec`: `{ rules: [{ enforce: "TRUE" }] }`
      * If `false`:
        * Do not create the `compute.skipDefaultNetworkCreation` policy
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
        * Where map key equals `iam.disableServiceAccountKeyUpload`, `iam.automaticIamGrantsForDefaultServiceAccounts`, or `compute.skipDefaultNetworkCreation`:
          * Same behaviour as `iam.managed.disableServiceAccountKeyCreation` above — boolean constraint, additional entry overrides the flag-created default.
        * Otherwise, create policy via org-policy module with:
          * `organisation` = config organisation ID
          * `policyName` = map key
          * `spec` = entry `spec` (if provided) — uses `gcp.orgpolicy.PolicySpec` type, passed through
          * `dryRunSpec` = entry `dryRunSpec` (if provided) — uses `gcp.orgpolicy.PolicyDryRunSpec` type, passed through
  * Create bindings for domain wide Google Identity
    * Use `iam` module
      * Assign binding to the organisation
      * Input `{ roles/resourcemanager.organizationViewer: [ domain:<domain> ]}`
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
  * organisation — `pulumi.Output<string>` — the organisation ID as provided
  * folders — `pulumi.Output<{ [name: string]: string }>` — map of folder display name to GCP-assigned numeric ID
  * foldersBindings — `pulumi.Output<{ [name: string]: { [roleId: string]: string[] } | null }>` — per-folder bindings, null if not provided
  * bindingsOrgAdmin — `pulumi.Output<{ [roleId: string]: string[] }>` — resolved org admin role-to-principal mapping
  * serviceAccountEmail — `pulumi.Output<string> | null` — SA email if enabled, null if not
  * projectSeedName — `pulumi.Output<string>` — seed project display name
  * projectSeedId — `pulumi.Output<string>` — seed project ID (name + postfix)
  * projectSeedNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * storageBucketName — `pulumi.Output<string>` — final bucket name including postfix
  * orgPolicies — `pulumi.Output<string[]> | null` — list of policy constraint names applied, null if none
