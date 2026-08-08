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
