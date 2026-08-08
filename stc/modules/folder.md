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
