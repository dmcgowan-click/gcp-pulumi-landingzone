# Standard Template Constructs

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

## Stacks

* Use `@pulumi/gcp`, `@pulumi/pulumi` unless otherwise specified
* Use TypeScript
* Module Resolution
  * Modules use relative imports for `@pulumi/*` packages — these resolve via Node's `node_modules` directory walking
  * The `Makefile` `prepare-infra` target must symlink the stack's `node_modules` into the `modules/` directory so that modules can resolve their dependencies: `ln -sfn <stack_node_modules> <modules_dir>/node_modules`
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
environments:
  - <environment name a>
  - <environment name b>
bindingsSuperAdmin:
  group: <email of super admin group email in Google Identity>
  bindings:
    - <role_id_a>
    - <role_id_b>
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
  * Create bindings for Super Admin Google Identity group
    * Validate that `bindingsSuperAdmin.group` starts with `group:` prefix at construction time. Error if not. Only `group:` principals are accepted by this stack.
    * Use `iam` module
      * Assign bindings to the organisation
      * Transform input: for each role in `bindingsSuperAdmin.bindings`, create an entry `{ <role>: [<group>] }` to match the IAM module's expected format
  * Return
    * Organisation
    * Folders
      * <key = name> = <value = numeric id (gcp assigned)>
      * Bindings (as null if NA)
    * BindingsSuperAdmin

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

* Use `@pulumi/gcp`, `@pulumi/pulumi`
* Use TypeScript
* Pulumi
  * `package.json` to be defined in calling stack. Implement code only
* All modules are to be `pulumi.ComponentResource` modules, not native TypeScript modules
  * Structure should be `modules/<module name>/index.ts`
  * The ComponentResource input interface must be named `<ModuleName>Args` (e.g. `IamArgs`)
* Where a YAML definition is provided use as a guide, but input should be a TypeScript object as it will be called by an underlying stack
* Modules are consumed by stacks via relative import and are not deployed independently. No Makefile target required.

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
  name: <resource name>
bindings:
  <role_id_a>:
    - <principal a>
    - <principal b>
  <role_id_b>:
    - <principal a>
    - <principal c>
```

* Requirements
  * Validate all input constraints at construction time (before deployment) for fast feedback
  * Exactly one of `organisation`, `folder`, `project`, `resource`
    * Error if more than one is provided OR none are provided
    * For `resource`
      * `type` must be provided
        * If `storage`, create bindings for a storage object identified by `name`
        * If `service_account`, create bindings for a service account identified by `email`
        * If anything else, error with message: `"Unsupported resource type '<type>'. Must be one of: storage, service_account"`
      * `name` must be provided
  * `bindings` must be provided with at least one role entry
    * `<role_id>` format is not validated client-side; defer validation to the GCP API at apply time
    * List of at least one `<principal>` must be provided
      * Ensure principal ID starts with one of
        * `user:`
        * `group:`
        * `serviceAccount:`
        * `domain:`
  * Return
    * organisation (as null if NA)
    * folder (as null if NA)
    * project (as null if NA)
    * resource (as null if NA)
      * type
      * name
    * bindings (same format as was inputted)

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

* Use `@pulumi/gcp`
* Requirements
  * Naming convention as follows
    * `<name>-<postfix>`
      * Take in a parameter of `name` for name
      * `postfix` is to be a 4 digit hexadecimal number
        * Randomly generate on initial creation, then preserved in state
  * Set labels
    * append
      * `module` = `project`
      * Take a parameter of `labels` in format `[{key: value}]`
  * Create in a parent entity to create the project under
    * Take in a parameter of 
      * `organisationId`
      * OR
      * `folderId`
    * At least one and only one can be set
      * Fast fail if condition not met
  * Attach to billing account
    * Take in a parameter of `billingAccount` for billing account ID
  * Enable APIs in list
    * Take in a parameter of `activateApis` in format `[api]`
  * Delete the default service account
  * Create the following outputs
    * `projectId`
