### Storage

Create a Pulumi `ComponentResource` module under `modules/storage` to create a storage bucket

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
