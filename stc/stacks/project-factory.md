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
