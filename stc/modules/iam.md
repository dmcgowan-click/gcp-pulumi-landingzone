### IAM

Create a Pulumi `ComponentResource` module under `modules/iam` to manage IAM bindings

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
  * Conditional Binding Deduplication
    * When a principal appears in a `conditions` entry for a given role, the unconditional binding for that role+principal pair must be skipped — only the conditional binding is created, not both
    * Build a per-role `Map<string, Set<pulumi.Input<string>>>` from `conditions` entries. Before creating each unconditional binding, check `Set.has(principal)` to decide whether to skip
    * `Set.has()` uses reference equality (`SameValueZero`), which matches both plain strings by value and `pulumi.Output` objects by object reference. Callers must pass the **same object reference** for a principal in both `bindings` and `conditions.members` for Output deduplication to work
  * Resource Naming
    * Unconditional bindings: `<component-name>-<roleId>-<principal>` with `/` and `:` replaced by `-`
    * Conditional bindings: `<component-name>-<roleId>-<conditionTitle>-<principal>` with `/` and `:` replaced by `-`
    * When a principal is a `pulumi.Output<string>` (not a plain string), use `member-<index>` in place of the principal value for the resource name (e.g. `<component-name>-<roleId>-member-0`). This ensures deterministic naming without requiring `.apply()` to resolve the value.
* Return
  * organisation (as null if NA)
  * folder (as null if NA)
  * project (as null if NA)
  * resource (as null if NA)
    * type
    * identifier
  * bindings — `pulumi.Output<{ [roleId: string]: string[] }>` — the role-to-principal mapping (principals resolved at apply time)
