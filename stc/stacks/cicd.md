### CICD (Continuous Integration / Continuous Delivery)

Create a Pulumi stack under `stacks/cicd` to create a cicd project along with cicd and artifact components. For use by GitHub or other source control

<!-- cicd components leverage CloudBuild for now. Expansion to support compute from other services to be added later -->

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
cloudBuild: # (optional) — 2nd gen Cloud Build repository links, created in the cicd project at defaultLocation
  repositoryLinks:
    <link_name>:
      connection: <short name of a pre-existing 2nd gen connection in the cicd project at defaultLocation (must be created manually beforehand for now)>
      repositories: # required — at least one
        - remoteUri: <git remote URI, e.g. https://github.com/owner/repo.git>
          name: <repository resource name (optional - default: derived from <link_name> and the repo slug)>
  triggers: # (optional) - If set, one or more triggers must be defined
    <trigger_name>:
      description: <trigger description (optional)>
      event: <[push-to-branch | push-new-tag | pull-request], required>
      source:
        linkName: <link_name as defined in repositoryLinks>
        remoteUri: <remoteUri as defined under that link_name's repositories>
      branch: <branch (or tag, for push-new-tag) regex to trigger on (optional - defaults to .*)>
      includedFiles: # (optional) - glob patterns; the build only runs when a changed file matches one of them
        - <glob pattern, e.g. modules/**>
      ignoredFiles: # (optional) - glob patterns; changes limited to matching files will not fire the build
        - <glob pattern, e.g. **/*.md>
      configuration:
        inlineCustom: # required — valid Cloud Build definition; maps to the cloudbuild-trigger module's configuration.inlineCustom (typed gcp.types.input.cloudbuild.TriggerBuild)
          # steps:
          #   - name: ubuntu
          #     args:
          #       - echo
          #       - hello world
      cicdSaAssume: # required — exactly one of orgSa / serviceProjectIDs
        orgSa: <[true | false] (mutually exclusive with serviceProjectIDs)>
        serviceProjectIDs: # (mutually exclusive with orgSa). If set, one or more service project ID's must be provided
          - <service project id>
      artifactWrite: <bool (optional, default: false) — when true, grants the trigger SA write to any artifact registry; maps to the cloudbuild-trigger module's artifactWrite>
      requireApproval: <bool (optional, default: false) — when true, builds require manual approval before they run; maps to the cloudbuild-trigger module's requireApproval>
labels: # (optional) - GCP project labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Additional dependencies: `@pulumi/random` (required via `project` module). Consumes the local `project`, `iam`, `labels` and `cloudbuild-trigger` modules (the latter only when `cloudBuild.triggers` is provided)
* Validation
  * `organisation` must be provided and non-empty
  * `folder` is optional. If not provided, searches for a folder with display name `common` under `organizations/<organisation>` using `gcp.organizations.getFoldersOutput` filtered by `parentId`. Error if no matching folder found or multiple matches
  * `billing` must be provided and non-empty
  * `seedProjectID` must be provided and non-empty
  * `defaultLocation` must be provided and non-empty
  * `artifactRegistries` entries (if provided): `format` must be one of `docker`, `npm`, `python`; `mode` must be `standard` (error otherwise); `immutable` must not be present on non-docker format registries (error if the key exists regardless of value)
  * `cloudBuild` (if provided): `repositoryLinks` must be defined with at least one `<link_name>`; each link's `connection` must be provided and non-empty; each link's `repositories` must contain at least one entry, and each entry's `remoteUri` must be provided and non-empty
  * `cloudBuild.triggers` (if provided): at least one `<trigger_name>` must be defined; each trigger's `event` must be one of `push-to-branch`, `push-new-tag`, `pull-request`; each trigger's `configuration.inlineCustom` must be provided; each trigger's `source.linkName` + `source.remoteUri` must match a repository created under `repositoryLinks` (error otherwise); each trigger's `cicdSaAssume` must set **exactly one** of `orgSa` (`true`) or `serviceProjectIDs` (non-empty) — error if both or neither ([CONV-EXCLUSIVE])
* Functions
  * `resolveFolder(orgId, folderId?)` — resolves the common folder ID (returns provided ID or looks up by name)
  * `createCicdProject(folderId, billing, additionalApis, labels)` — creates the CICD project via the project module
  * `createArtifactRegistries(registries, projectId, seedProjectID, defaultLocation, labels)` — creates registries, SA, and IAM bindings
  * `createRepositoryLinks(repositoryLinks, projectId, defaultLocation)` — creates the 2nd gen Cloud Build repositories under each link's connection
  * `createTriggers(triggers, projectId, defaultLocation, seedProjectID, repositoryLinks)` — creates Cloud Build triggers via the `cloudbuild-trigger` module, resolving each trigger's `source` from the created repository links and its `saAssume` from `cicdSaAssume`
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
      * When `cloudBuild` is provided, also enable `cloudbuild.googleapis.com` and `secretmanager.googleapis.com` (required for 2nd gen Cloud Build connections and repository links)
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
  * If `cloudBuild` provided
    * `repositoryLinks` must be defined with at least one `<link_name>`
    * Repository links are created in the **cicd** project at `defaultLocation`
    * For each `<link_name>`, for each entry under `repositories`, create a `gcp.cloudbuildv2.Repository`:
      * `name` = the entry's `name` if provided, otherwise derived deterministically from `<link_name>` and the repository slug (sanitised from `remoteUri`)
      * `location` = `defaultLocation`
      * `project` = the cicd project ID (output from the project module)
      * `remoteUri` = the entry's `remoteUri`
      * `parentConnection` = the full connection resource path `projects/<cicd project ID>/locations/<defaultLocation>/connections/<connection>`, resolved from the link's `connection` short name. The connection itself is not created by this stack — it must exist beforehand (2nd gen connections require manual setup for now)
    * If `triggers` provided (via the `createTriggers(...)` function)
      * At least one `<trigger_name>` must be provided
      * Triggers consume the `cloudbuild-trigger` module and must be created **after** `repositoryLinks` — each trigger references a created repository as its `source`
      * For each `<trigger_name>`, call the `cloudbuild-trigger` module with:
        * `name` = `<trigger_name>`
        * `project` = cicd project ID (Output from the project module; the module `project` input supports [CONV-INPUT])
        * `region` = `defaultLocation` (the module names its trigger-location input `region`, consistent with other modules)
        * `description` = `description` (optional)
        * `event` = `event`
        * `source` = the full 2nd gen repository resource name of the repository identified by `source.linkName` + `source.remoteUri`. Resolve the repository name using the **same** derivation as `createRepositoryLinks` (the entry's `name` if provided, otherwise `<link_name>-<slug>` where `<slug>` is sanitised from `remoteUri`), producing `projects/<cicd project ID>/locations/<defaultLocation>/connections/<connection>/repositories/<repoName>`. `source.linkName` + `source.remoteUri` must match an entry created under `repositoryLinks`; error otherwise
        * `branch` = `branch` (omit when not provided — the module defaults to `.*`)
        * `includedFiles` = `includedFiles` (optional; passed through unchanged)
        * `ignoredFiles` = `ignoredFiles` (optional; passed through unchanged)
        * `configuration.inlineCustom` = `configuration.inlineCustom` (cast to `gcp.types.input.cloudbuild.TriggerBuild`)
        * `artifactWrite` = `artifactWrite` (optional; passed through unchanged — when `true`, the module grants the trigger SA `roles/artifactregistry.writer` on the cicd project)
        * `requireApproval` = `requireApproval` (optional; passed through unchanged — when `true`, the module sets the trigger's `approvalConfig.approvalRequired`)
        * `saAssume` = resolved from `cicdSaAssume` (exactly one of `orgSa` / `serviceProjectIDs`):
          * If `orgSa` is `true`: look up the org CICD service account (`cicd-org`, created by the organisation stack) in the seed project via `gcp.serviceaccount.getAccountOutput({ accountId: "cicd-org", project: seedProjectID })`; `saAssume` = `[<that SA email>]`
          * If `serviceProjectIDs`: for each service project ID, strip the 4-char [CONV-POSTFIX] to get `<slug>`, then look up the project CICD (power-user) service account `cicd-<slug>` (created by the service-project module) in the seed project via `gcp.serviceaccount.getAccountOutput({ accountId: "cicd-<slug>", project: seedProjectID })`; `saAssume` = the list of resolved SA emails
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
  * repositoryLinks — `pulumi.Output<{ [name: string]: string }>` — map of repository resource name to its full GCP resource name (`cloudBuild` only; empty when not provided)
  * triggers — `pulumi.Output<{ [name: string]: string }>` — map of trigger name to its Cloud Build trigger ID (`cloudBuild.triggers` only; empty when not provided)
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged label set

