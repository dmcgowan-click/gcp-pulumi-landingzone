### Service App Static

Create a Pulumi stack under `stacks/service-app-static` to create a static web hosting service

* State backend: standard `service` stack state backend per GLOBAL.md, keyed on `serviceProjectID`'s per-environment project state bucket.
* Dependencies (`package.json`): `@pulumi/gcp`, `@pulumi/pulumi`, `js-yaml` (parse the common file); `@types/js-yaml`, `@types/node` (dev)
  * Consumed modules (`ip-address`, `certificate`, `labels`) require no dependencies beyond `@pulumi/gcp` + `@pulumi/pulumi`, so no additional runtime packages are needed.
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
domains: 
  - domain: <An FQDN for web access>
    zoneName: <name of GCP zone to host the FQDN (optional - if not provided, you are responsible for creating the DNS A/AAAA records pointing at the reserved IP)> # reserved for future functionality (DNS record creation) — not yet consumed
    primary: <bool (optional, default: false)>
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
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)> # reserved for future functionality (regional backend resources) — not yet consumed
```

> **Scope note:** This stack currently reserves the ingress primitives only (global IP + certificate map). The storage backend, URL map, and load balancer that wire these together (and serve static content) are additional functionality to be added at a later date. Until then, `zoneName` and `defaultLocation` are accepted but not consumed.

* Requirements
  * Validation
    * `domains` must contain at least one entry (error if missing or empty).
    * `domain` must be a single FQDN — a resolved plain string containing no commas or whitespace. Domain format/ownership validation deferred per [CONV-VALIDATE-API].
    * Duplicate FQDNs across `domains` entries will fail certificate module validation (hostname uniqueness within a map); keep FQDNs unique. At-most-one `primary` is likewise enforced by the certificate module.
  * Advisory
    * For each `domains` entry where `zoneName` is not provided, emit a `pulumi.log.warn(...)` advising that creating the DNS A/AAAA records for `<domain>` pointing at the reserved IP is the user's responsibility (no managed zone supplied). Advisory only — does not block deployment.
  * Reserve a global IP address
    * Use `ip-address` module
    * Inputs
      * `name` = `<namePrefix>-ipadd-global-<env>`
      * `project` = `serviceProjectID`
      * `type.external.type` = Global
  * Generate a certificate map
    * Use `certificate` module
    * Inputs
      * `project` = `serviceProjectID`
      * `certificateMap`
        * `name` = `<namePrefix>-certmap-<env>`
        * `labels` = the merged stack labels (see `labels` below)
        * `certificates`
          * For each entry under `domains`
            * Certificate key = `<namePrefix>-cert-<domain-slug>-<hash6>-<env>`, where:
              * `<domain-slug>` = the FQDN lowercased with each run of non-`[a-z0-9]` characters replaced by `-` and leading/trailing `-` stripped (e.g. `www.example.com` → `www-example-com`). Truncate the slug so the full key stays ≤63 chars.
              * `<hash6>` = first 6 hex chars of a SHA-256 of the full FQDN — guarantees a unique, deterministic key when two domains slugify to the same value or the slug is truncated.
              * The full key is prefixed with `<namePrefix>`, so it satisfies the certificate module's key rule `^[a-z]([-a-z0-9]*[a-z0-9])?$` (provided `namePrefix` starts with a lowercase letter).
              * `domains` = `domain`
              * `primary` = `primary` when provided, otherwise omit (certificate module defaults to `false`)
  * `labels` is optional
    * The merged stack labels must be passed to every resource / module that supports labels (e.g. the reserved IP address and the certificate map). Resources that do not support labels (e.g. the classic managed SSL certificate) simply ignore them.
    * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
    * Merge order (after sanitisation, later wins on key collision): sanitised user labels → stack hardcoded labels → module-level defaults
      * Stack merges sanitised output with its own defaults: `{ stack: "service-app-static" }`
      * The merged result (still a plain object at this point — `apply()` the Labels output then spread with hardcoded labels) is passed to modules
    * The `ip-address` and `certificate` module `labels` args accept `pulumi.Input<{ [key: string]: string }>` and merge per [CONV-LABELS]
* Return
  * ipAddress — `pulumi.Output<string>` — the reserved global IP address
  * ipAddressName — `pulumi.Output<string>` — the reserved address resource name
  * ipAddressSelfLink — `pulumi.Output<string>` — the self link URI of the reserved address
  * certificateMapResourceUrl — `pulumi.Output<string>` — the certificate map reference (`//certificatemanager.googleapis.com/...` format) for use as the `load-balancer` module `certificateMap` input
  * certificateMapName — `pulumi.Output<string>` — the short name of the created certificate map
  * certificateMapId — `pulumi.Output<string>` — the resource id of the created certificate map
