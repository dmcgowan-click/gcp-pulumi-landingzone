### cicd (Continuous Integration / Continuous Delivery)

Create a Pulumi stack under `stacks/cicd` to create cicd and artifact components. For use by GitHub or other source control

NOTE: cicd components leverage CloudBuild for now. Expansion to support compute from other services to be added later

* Accept an input based on the following YAML definition

```yaml
organisation: <organisation numeric ID>
folder: <common folder numeric ID> # (optional - if not provided, looks up folder by name "common" under the organisation)
billing: <billing account id (format: XXXXXX-XXXXXX-XXXXXX)>
seedProjectID: <project ID of the seed project created by the organisation stack>
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)>
apisAdditional: # (optional)
  - <additional apis>
artifactRegistries: # (optional)
  <registry_name>:
    format: <[docker | npm | python]> #More to be added
    mode: standard # (only 'standard' supported; remote/virtual planned)
    multiRegion: <valid multi region> # (Optional)
    immutable: <[enabled | disabled] default to disabled> # (Optional - docker format only; error if present on non-docker registries)
    cleanupPolicies: <[delete | keep] default to delete> # (Optional)
    labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
      <key>: <value>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Additional dependencies: `@pulumi/random` (required via `project` module)
* Validation
  * `organisation` must be provided and non-empty
  * `folder` is optional. If not provided, searches for a folder with display name `common` under `organizations/<organisation>` using `gcp.organizations.getFoldersOutput` filtered by `parentId`. Error if no matching folder found or multiple matches
  * `billing` must be provided and non-empty
  * `seedProjectID` must be provided and non-empty
  * `defaultLocation` must be provided and non-empty
  * `artifactRegistries` entries (if provided): `format` must be one of `docker`, `npm`, `python`; `mode` must be `standard` (error otherwise); `immutable` must not be present on non-docker format registries (error if the key exists regardless of value)
* Functions
  * `resolveFolder(orgId, folderId?)` — resolves the common folder ID (returns provided ID or looks up by name)
  * `createCicdProject(folderId, billing, additionalApis, labels)` — creates the CICD project via the project module
  * `createArtifactRegistries(registries, projectId, seedProjectID, defaultLocation, labels)` — creates registries, SA, and IAM bindings
* Requirements
  * `defaultLocation` is required
    * Used as the Artifact Registry `location` for registries that do not specify `multiRegion`
    * Where `multiRegion` is provided on a registry, `multiRegion` takes precedence over `defaultLocation`
  * Create cicd project
    * Use `project` module
    * Create under `folder` (common folder numeric ID)
    * Assign to `billing` account
    * Name `cicd`
    * APIs - Hardcoded
      * cloudresourcemanager.googleapis.com
      * cloudbilling.googleapis.com
      * iam.googleapis.com
      * artifactregistry.googleapis.com
    * APIs - Additional
      * APIs `apisAdditional`
    * No IAM Bindings
  * Create artifact registries and RW service account
    * Use `gcp.artifactregistry.Repository` for each entry under `artifactRegistries`
    * Create in the cicd project (use project ID output from the project module)
    * For each entry under `artifactRegistries`, create an artifact registry
      * `name` = `artifactRegistries.<key>`
      * `description` = `Registry <name> for <format> artifacts`
      * `format` = `artifactRegistries.<key>.format`
      * `mode` = `artifactRegistries.<key>.mode`. Only `standard` mode is supported; error if any other value is provided
      * `location` = `artifactRegistries.<key>.multiRegion` if provided, otherwise `defaultLocation`
      * `immutable` = Only applicable where format is docker. `artifactRegistries.<key>.immutable`. Default to disabled. Error if the `immutable` key is present on non-docker format registries (regardless of value)
      * `cleanupPolicies` = `artifactRegistries.<key>.cleanupPolicies`. Default to `delete`.
        * Set `cleanupPolicyDryRun: false` on the repository
        * Creates a single cleanup policy rule:

          | Format | `olderThan` | `tagState` |
          |--------|-------------|------------|
          | docker | 2592000s | UNTAGGED |
          | npm / python | 2592000s | _(not set)_ |

        * Action = `DELETE` when `cleanupPolicies` is `delete`; `KEEP` when `cleanupPolicies` is `keep` (prevents deletion of matching artifacts)
      * `labels` = Each registry inherits the project-level merged labels. If registry-level labels are provided, sanitise them through `new Labels(...)` and merge with project-level merged labels (sanitised registry-level wins on key collision). If no registry-level labels are provided, use project-level merged labels as-is
    * Where `artifactRegistries` is 1 or more
      * Create a service account using `gcp.serviceaccount.Account`
      * Create under the seed project (config `seedProjectID`)
        * NOTE: This is not a typo, keeping the SA here provides an additional layer of protection from deletion and modification
      * Name: `cicd-artifact-rw`. Validation deferred to GCP API at apply time.
        * Description: `Service Account for <name> - Artifact Registries Read / Write. Project wide bindings on this project`
      * Use `iam` module
        * Assign bindings to the **cicd** project (where the artifact registries reside)
        * For `bindings`
          * Transform input: Create static map of `{ roles/artifactregistry.writer: [serviceAccount:<sa-email>], roles/artifactregistry.viewer: [serviceAccount:<sa-email>] }`. Input to `bindings`
  * `labels` is optional
    * Labels only apply to resources that support them (e.g. seed project). Folders do not support labels or tags.
    * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
    * Merge order (after sanitisation, later wins on key collision): sanitised user labels → stack hardcoded labels → module-level defaults
      * Stack merges sanitised output with its own defaults: `{ stack: "cicd" }`
      * The merged result (still a plain object at this point — `apply()` the Labels output then spread with hardcoded labels) is passed to modules
    * Project module `labels` arg must accept `pulumi.Input<{ [key: string]: string }>` to support receiving Outputs
* Return
  * projectCicdName — `pulumi.Output<string>` — cicd project display name
  * projectCicdId — `pulumi.Output<string>` — cicd project ID (name + postfix)
  * projectCicdNumber — `pulumi.Output<string>` — GCP-assigned numeric project identifier
  * artifactRegistries — `pulumi.Output<{ [name: string]: string }>` — map of registry name to full GCP resource name (e.g. `projects/<project>/locations/<location>/repositories/<name>`)
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged label set

