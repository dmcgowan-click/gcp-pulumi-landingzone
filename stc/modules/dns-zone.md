### DNS Zone

Create a Pulumi module under `modules/dns-zone` to create a DNS zone

* No additional dependencies beyond base requirements
* Accept an input based on the following YAML definition

<!-- NOTE: Under development. Private zone support to be added -->

```yaml
zoneName: <zone name (1-63 chars; lowercase letters, digits, hyphens; must start with a letter, must not end with a hyphen)>
dnsName: <dnsName (must be a valid FQDN, e.g, service.mydomain.com. — trailing dot auto-appended if missing)>
description: <zone description> # (optional)
visibility: <[public | private] defaults to public>
project: <project ID string>
labels: # (optional) - GCP resource labels (lowercase keys/values, max 63 chars)
  <key>: <value>
```

* Requirements
  * Input Types
    * `project`, `zoneName`, `dnsName`, `description`: [CONV-INPUT]. Construction-time name validation is skipped for unresolved Outputs (only resolved plain strings are validated).
  * `zoneName` must be provided
    * Must be 1–63 characters
    * Allowed characters: lowercase letters, digits, hyphens
    * Must start with a lowercase letter
    * Must not end with a hyphen
    * Error with descriptive message if validation fails
  * `dnsName` must be provided
    * Must be a valid FQDN (e.g. `service.mydomain.com.`)
    * If the value does not end with a trailing dot (`.`), the module must auto-append it — the GCP API requires a trailing dot
    * Must contain at least one dot (excluding the trailing dot)
    * Error with descriptive message if validation fails
  * `project` must be provided. Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number [CONV-VALIDATE-API]
  * `description` optional
  * `visibility` optional
    * Default to `public`
    * If `private` provided, throw an error stating that private DNS zones are not yet supported
    * If any other value provided, throw an error stating the value is invalid
  * `labels` is optional
    * Apply [CONV-LABELS] with module defaults: `{ module: "dns-zone", deployed_by: "pulumi" }`
* Return
  * zoneName — `pulumi.Output<string>` — the DNS zone resource name
  * dnsName — `pulumi.Output<string>` — the DNS name of the zone (with trailing dot)
  * nameServers — `pulumi.Output<string[]>` — GCP-assigned name servers
  * managedZoneId — `pulumi.Output<string>` — GCP-assigned zone ID
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults
