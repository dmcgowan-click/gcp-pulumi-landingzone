### Service App Static

Create a Pulumi stack under `stacks/service-app-static` to create a static web hosting service

* Dependencies (`package.json`): `@pulumi/gcp`, `@pulumi/pulumi`, `js-yaml` (parse the common file); `@types/js-yaml`, `@types/node` (dev)
* Stack input
  * Accept an input based on the following YAML definition
    * Multiple yaml definitions permitted
      * Each yaml is a separate pulumi stack. Each yaml is a native Pulumi stack config file — keys are namespaced under `config:` with the `service-app-static:` prefix (e.g. `config: { service-app-static:<env-parameter-key>: <env-parameter-value> }`)
      * Each yaml represents an environment defined in the landing zone (e.g, dev, prod, etc)
      * Each yaml must follow the following format to identify the environment it belongs to
        * `Pulumi.<environment>.yaml`
        * Environment is determined from filename, hence it not provided as a parameter in the yaml file
        * At runtime `<env>` = the current Pulumi stack name (`pulumi.getStack()`), used for both config resolution and resource naming (e.g. the IP address name)
    * Where a setting is labelled as follows
      * `# (optional - takes priority over initiative common file definition if defined)`
      * It will take priority over corresponding settings in Common yaml definition specified below stack yaml definition

```yaml
serviceProjectID: <project ID for this given app / environment>
labels: # (optional) - GCP resource labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Common input
  * Read a common file with the following YAML definition
    * Single yaml file permitted. Must follow the following format
      * `Pulumi-common.yaml`
    * Not a Pulumi stack config — parsed manually at runtime with `js-yaml` via `path.join(__dirname, "Pulumi-common.yaml")`. Distinct from `Pulumi.yaml` (the Pulumi project file).

```yaml
namePrefix: <name for stack. Resources will be prefixed>
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)>
```

* Requirements
  * Reserve a global IP address
    * Use `ip-address` module
    * Inputs
      * `name` = `<namePrefix>-ipadd-global-<env>`
      * `project` = `serviceProjectID`
      * `type.external.type` = Global
  * `labels` is optional
    * Labels only apply to resources that support them (e.g. the reserved IP address).
    * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
    * Merge order (after sanitisation, later wins on key collision): sanitised user labels → stack hardcoded labels → module-level defaults
      * Stack merges sanitised output with its own defaults: `{ stack: "service-app-static" }`
      * The merged result (still a plain object at this point — `apply()` the Labels output then spread with hardcoded labels) is passed to modules
    * The `ip-address` module `labels` arg accepts `pulumi.Input<{ [key: string]: string }>` and merges per [CONV-LABELS]
* State backend
  * This is a `service` stack. Its state is stored in the project state bucket provisioned for `serviceProjectID` (created by the project-factory stack), selected per environment via `state.yaml` (see GLOBAL.md service stack requirements).
  * Provide a `state.sample.yaml` with env-keyed placeholders (one key per environment, matching the Pulumi stack name):
```yaml
---
<env1 (e.g. dev)>: <project state bucket for env1 (from project-factory outputs)>
<env2 (e.g. prod)>: <project state bucket for env2 (from project-factory outputs)>
```
* Return
  * ipAddress — `pulumi.Output<string>` — the reserved global IP address
  * ipAddressName — `pulumi.Output<string>` — the reserved address resource name
  * ipAddressSelfLink — `pulumi.Output<string>` — the self link URI of the reserved address

