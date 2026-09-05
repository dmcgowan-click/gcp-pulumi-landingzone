### IP Address

Create a Pulumi `ComponentResource` module under `modules/ip-address` to create ip address reservation.

> **Design note:** Module supports external IP addresses only. Other reservation types to be introduced at a later date.

* No additional dependencies beyond `@pulumi/gcp` and `@pulumi/pulumi`
* Accept an input based on the following YAML definition

```yaml
name: <string, required — GCP resource name prefix. Validated: ^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars>
project: <project ID string>
description: <string (optional, default: "IP Address <name>")>
type:
  external:
    ipVersion: <[IPv4 | IPv6] (optional, default: IPv4)>
    type: <[ Regional | Global ] >
    region: <valid region. Required when type is region>
labels: # (optional) — merged per [CONV-LABELS]
```

* GCP Resource Mapping
  * When `type.external.type` is `Regional` → create `gcp.compute.Address` with `addressType: "EXTERNAL"`
  * When `type.external.type` is `Global` → create `gcp.compute.GlobalAddress` with `addressType: "EXTERNAL"`
* Requirements
  * Input Types
    * `name`, `project`: [CONV-INPUT]. Construction-time name validation is skipped for unresolved Outputs (only resolved plain strings are validated).
    * `name`: Must match `^[a-z]([-a-z0-9]*[a-z0-9])?$`, max 63 characters. Validated at construction time.
    * `project` must be provided. Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number.
    * `description`: Optional. If not provided, default to `"IP Address <name>"`. Passed to the GCP resource `description` field.
  * Labels
    * Optional `labels` input. Merge per [CONV-LABELS]: user-provided labels → module defaults (`module: "ip-address"`, `deployed_by: "pulumi"`). Applied to all resources that support labels.
  * `type` must be provided
    * Exactly one of `external` (or `internal` in future) must be provided [CONV-EXCLUSIVE]
    * `external`:
      * `type`: Required. Must be one of `Regional` or `Global`. Error with descriptive message if an unrecognised value is provided.
      * `region`: Required when `external.type` is `Regional`. Error if not provided. Must not be provided when `external.type` is `Global` — error if provided. Region format validation deferred to GCP API [CONV-VALIDATE-API].
      * `ipVersion`: Optional. Must be one of `IPv4` or `IPv6`. Default to `IPv4` if not provided. Error with descriptive message if an unrecognised value is provided. IPv6 + Regional compatibility deferred to GCP API [CONV-VALIDATE-API].
* Return
  * `address` — `pulumi.Output<string>` — the allocated IP address
  * `name` — `pulumi.Output<string>` — the resource name
  * `selfLink` — `pulumi.Output<string>` — the self link URI of the reserved address
  * `addressType` — `pulumi.Output<string>` — `"EXTERNAL"`
  * `labels` — `pulumi.Output<{ [key: string]: string }>` — final merged map including module defaults
