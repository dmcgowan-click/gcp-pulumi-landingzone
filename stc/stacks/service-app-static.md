### Service App Static

Create a Pulumi stack under `stacks/service-app-static` to create a static web hosting service

* State backend: standard `service` stack state backend per GLOBAL.md, keyed on the deployment environment (`STACK_ENV`), selecting that environment's project state bucket.
  * `STACK_ENV` and the Pulumi stack name (`pulumi.getStack()`) must be equal — the Makefile sets the stack name to `STACK_ENV`. State-bucket selection keys on `STACK_ENV` while config resolution and resource naming use `pulumi.getStack()`; if they diverge the wrong per-environment state bucket would be selected for the active config.
* Dependencies (`package.json`): `@pulumi/gcp`, `@pulumi/pulumi`, `@pulumi/random`, `js-yaml` (parse the common file); `@types/js-yaml`, `@types/node` (dev)
  * Consumed modules: `ip-address`, `certificate`, `labels`, and `load-balancer` require no dependencies beyond `@pulumi/gcp` + `@pulumi/pulumi`. The `storage` module additionally requires `@pulumi/random` (for its resource-name postfix), so that package must be included in the calling stack's `package.json`.
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
    zoneName: <name of an existing GCP managed DNS zone (provisioned by the landing zone) to host the FQDN (optional - if not provided, you are responsible for creating the DNS A record pointing at the reserved IP)> # when set, an A record for <domain> is created in this pre-existing zone
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
defaultLocation: <valid gcp region for regional resources (e.g. australia-southeast1)> # consumed as the storage bucket location
```

* Requirements
  * Config reads
    * Env-level values (`serviceProjectID`, `domains`, `labels`) are native Pulumi stack config. Read `serviceProjectID` via `config.require`, and the nested `domains` / `labels` structures via `config.requireObject` / `config.getObject` respectively.
    * Common values (`namePrefix`, `defaultLocation`) are parsed from `Pulumi-common.yaml` with `js-yaml` (not Pulumi config).
  * Validation
    * `namePrefix` must be provided and, since every resource name is `<namePrefix>-...`, must satisfy the GCP name rule `^[a-z]([-a-z0-9]*[a-z0-9])?$` (lowercase alphanumeric and hyphens, starting with a lowercase letter). It must also be short enough that the longest generated name stays within limits — notably the storage bucket name `<namePrefix>-sitestatic-<env>` must be ≤58 characters before the postfix is appended (see `storage` module).
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
      * `labels` = the merged stack labels (see `labels` below)
  * Generate a certificate map
    * Use `certificate` module
    * Inputs
      * `project` = `serviceProjectID`
      * `certificateMap`
        * `name` = `<namePrefix>-certmap-<env>`
        * `labels` = the merged stack labels (see `labels` below)
        * `certificates`
          * For each entry under `domains`, create one certificate map entry:
            * Certificate key = `<namePrefix>-cert-<domain-slug>-<hash6>-<env>`, where:
              * `<domain-slug>` = the FQDN lowercased with each run of non-`[a-z0-9]` characters replaced by `-` and leading/trailing `-` stripped (e.g. `www.example.com` → `www-example-com`). Truncate the slug so the full key stays ≤63 chars.
              * `<hash6>` = first 6 hex chars of a SHA-256 of the full FQDN — guarantees a unique, deterministic key when two domains slugify to the same value or the slug is truncated.
              * The full key is prefixed with `<namePrefix>`, so it satisfies the certificate module's key rule `^[a-z]([-a-z0-9]*[a-z0-9])?$` (provided `namePrefix` starts with a lowercase letter).
            * `domains` = `domain`
            * `primary` = `primary` when provided, otherwise omit (certificate module defaults to `false`)
            * `labels` = the merged stack labels (see `labels` below), so the individual `gcp.certificatemanager.Certificate` resources carry the stack labels in addition to the map
  * Create a storage bucket
    * Use `storage` module
    * Inputs
      * `name` = `<namePrefix>-sitestatic-<env>`
      * `postfix` = true
      * `project` = `serviceProjectID`
      * `location` = `defaultLocation`
      * `labels` = the merged stack labels (see `labels` below)
  * Seed default site content
    * A default `index.html` lives in the stack directory at `resources/index.html`. It must reside inside the stack directory so the Makefile rsync copies it into the working directory alongside the stack code.
    * Seeding is performed by a Makefile target (`seed-index`), NOT a Pulumi-managed resource. This preserves "seed only when absent" semantics — a Pulumi `gcp.storage.BucketObject` would enforce and overwrite the object on every `pulumi up`, clobbering content later published by an application.
    * Behaviour: read the deployed `bucketName` stack output, then upload `resources/index.html` to `gs://<bucket>/index.html` ONLY if no `index.html` already exists in the bucket. If one exists, skip without overwriting.
    * Run after deployment: `make seed-index STACK_DIR=stacks/service-app-static STACK_ENV=<env>`.
  * Create a load balancer
    * Use `load-balancer` module
    * Inputs
      * `name` = `<namePrefix>-lb-ext-global-<env>`
      * `project` = `serviceProjectID`
      * `type.application.external.regionGlobal.frontend`
        * `<frontend_name>` = tls
          * `protocol.type` = HTTPS
          * `protocol.certificateMap` = the certificate map short name (`certificateMapName` output from the `certificate` module; the `load-balancer` module expands it to the full certificate-manager resource path)
          * `ipAddress.type` = static
          * `ipAddress.addressName` = the reserved global IP address name (`ipAddressName` output from the `ip-address` module)
      * `type.application.external.regionGlobal.backend`
        * `<backend_name>` = storage-static
          * `bucket.bucketName` = the storage bucket name (`bucketName` output from the `storage` module)
          * `cloudCDN.enabled` = true
      * `type.application.external.regionGlobal.routing.mode` = advancedHostAndPathRule
      * `type.application.external.regionGlobal.routing.defaultBackend` = `<backend_name>`
      * `labels` = the merged stack labels (see `labels` below)
  * Create a FQDN record
    * No module exists for DNS record sets; create a `gcp.dns.RecordSet` directly (`@pulumi/gcp`). The managed zone is NOT created here — it must already exist (provisioned by the landing zone); this stack only adds records to it.
    * For each `domains`
      * If `zoneName` is set
        * Create a `gcp.dns.RecordSet`
          * Pulumi resource name = `<namePrefix>-dnsrec-<domain-slug>-<env>`, where `<domain-slug>` is the FQDN slugified per the certificate-key rule above (each run of non-`[a-z0-9]` characters replaced by `-`, leading/trailing `-` stripped)
          * `project` = `serviceProjectID` (the project hosting the managed zone)
          * `managedZone` = `zoneName` (the pre-existing landing-zone managed zone)
          * `name` (DNS name) = `domain`, with a trailing dot appended if not already present (GCP requires FQDN form)
          * `type` = `A`
          * `ttl` = `300` (seconds; 5 minutes)
          * `rrdatas` = `[<reserved global IP address>]` (the `ipAddress` / `address` output from the `ip-address` module)
        * Only an IPv4 `A` record is created — the reserved global IP defaults to IPv4. AAAA/IPv6 records are out of scope.
  * `labels` is optional
    * The merged stack labels must be passed to every resource / module that supports labels (e.g. the reserved IP address, the certificate map and its certificates, the storage bucket, and the load balancer). Resources that do not support labels (e.g. the classic managed SSL certificate) simply ignore them.
    * Sanitisation: pass user-provided config labels through `new Labels(...)` to sanitise into GCP-compliant format. Hardcoded labels defined in stack or module code are already compliant and do not require sanitisation.
      * The `labels` module requires at least one entry, so only instantiate `new Labels(...)` when the user supplied a non-empty `labels` map. When no user labels are provided, skip `Labels` entirely and start from the stack hardcoded defaults alone (`{ stack: "service-app-static" }`).
    * Merge order (after sanitisation, later wins on key collision): sanitised user labels → stack hardcoded labels → module-level defaults
      * Stack merges sanitised output with its own defaults: `{ stack: "service-app-static" }`
      * Merge inside an `apply` on the `Labels` output: within the callback the sanitised value is a resolved plain object, so spread it together with the hardcoded `{ stack: "service-app-static" }`. The `apply` yields a `pulumi.Output<{ [key: string]: string }>` which is passed to modules (whose `labels` args accept `pulumi.Input<...>`).
    * The `ip-address`, `certificate`, `storage`, and `load-balancer` module `labels` args accept `pulumi.Input<{ [key: string]: string }>` and merge per [CONV-LABELS]
* Return
  * ipAddress — `pulumi.Output<string>` — the reserved global IP address
  * ipAddressName — `pulumi.Output<string>` — the reserved address resource name
  * ipAddressSelfLink — `pulumi.Output<string>` — the self link URI of the reserved address
  * certificateMapResourceUrl — `pulumi.Output<string>` — the certificate map reference in `//certificatemanager.googleapis.com/...` format
  * certificateMapName — `pulumi.Output<string>` — the short name of the created certificate map (passed to the `load-balancer` module `protocol.certificateMap` input, which expands it to the full resource path)
  * certificateMapId — `pulumi.Output<string>` — the resource id of the created certificate map
  * bucketName — `pulumi.Output<string>` — the created storage bucket name (including postfix)
  * loadBalancerIpAddresses — `{ [frontendKey: string]: pulumi.Output<string> }` — IP address of each load balancer frontend forwarding rule, keyed by frontend key
  * loadBalancerUrlMapSelfLink — `pulumi.Output<string>` — self link of the load balancer URL map
  * loadBalancerForwardingRuleSelfLinks — `{ [frontendKey: string]: pulumi.Output<string> }` — self link of each load balancer frontend forwarding rule, keyed by frontend key
  * dnsRecordNames — `pulumi.Output<string>[]` — the DNS record names created (one per `domains` entry that supplied a `zoneName`); empty when no zones were supplied
