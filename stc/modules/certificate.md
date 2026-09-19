### Certificate

Create a Pulumi `ComponentResource` module under `modules/certificate` to create either A) a single classic Google-managed SSL certificate, or B) a Certificate Manager certificate map containing one or more certificates.

* **Additional dependencies:** `@pulumi/gcp`, `@pulumi/pulumi` (included in calling stack's `package.json`)

> **Design note:** Two mutually exclusive modes:
> * `certificate` — a single **classic** Google-managed SSL certificate (`gcp.compute.ManagedSslCertificate`). Always global, google-managed, public, and load-balancer authorized. Does **not** support labels, location, scope, certificate type, authority type, or DNS authorization.
> * `certificateMap` — a **Certificate Manager** certificate map (`gcp.certificatemanager.CertificateMap`) plus one or more `gcp.certificatemanager.Certificate` resources, their `gcp.certificatemanager.CertificateMapEntry` records, and (for DNS authorization) `gcp.certificatemanager.DnsAuthorization` resources.
>
> Self-managed certificates (`certificateType: self`) and private certificate authorities (`authorityType: private`) are not yet supported.

* Accept an input based on the following YAML definition

```yaml
project: <project ID string>
certificate: # (mutually exclusive with certificateMap)
  name: <string, required — GCP resource name prefix. Validated: ^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars>
  description: <string (optional, default: "Certificate <name>")>
  domains: <string, required — comma-separated list of domains served by the certificate>
certificateMap: # (mutually exclusive with certificate)
  name: <string, required — GCP resource name prefix. Validated: ^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars>
  description: <string (optional, default: "Certificate map <name>")>
  labels: # (optional) — applied to the CertificateMap, merged per [CONV-LABELS]
    <key>: <value>
  certificates: # required — at least one entry; key is the certificate resource name (^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars)
    <cert_key>:
      description: <string (optional, default: "Certificate <cert_key>")>
      location: <string (optional; when omitted the certificate is global)>
      scope: <string, only "DEFAULT" supported for now (optional, default: "DEFAULT")>
      certificateType: <[google | self] (optional, default: google — only google supported at this time)>
      authorityType: <[public | private] (optional, default: public — only public supported at this time)>
      domains: <string, required — comma-separated list of domains served by the certificate>
      authorisationType: <[LB | DNS] (optional, default: LB)>
      authorisationZone: <string — managed DNS zone name; required when authorisationType = DNS, invalid when LB. All of this cert's domains must belong to this single zone.>
      primary: <bool (optional, default: false) — when true, also create a PRIMARY CertificateMapEntry (fallback for unmatched SNI). At most one cert per map may be primary.>
      labels: # (optional) — applied to the Certificate, merged per [CONV-LABELS]
        <key>: <value>
```

* Requirements
  * Input Types
    * `project`, `authorisationZone`: [CONV-INPUT]. Construction-time name validation is skipped for unresolved Outputs (only resolved plain strings are validated).
    * `labels` (both the `certificateMap.labels` and per-certificate `labels`): [CONV-INPUT] — accept `pulumi.Input<{ [key: string]: string }>` so sanitised label Outputs from a calling stack can be passed. Validation is performed on the resolved value (within `apply`) per [CONV-LABELS].
    * Target: exactly one of `certificate`, `certificateMap` must be provided [CONV-EXCLUSIVE].
  * Validation
    * `project` must be provided. Must be a GCP project ID string (e.g. `my-project-a1b2`), not a numeric project number [CONV-VALIDATE-API].
    * `name` (both modes) and each `certificates` `<cert_key>`: must match `^[a-z]([-a-z0-9]*[a-z0-9])?$`, max 63 characters. Validated at construction time.
    * `domains` (both modes): must be provided and non-empty. Split on commas and trim whitespace; each resulting entry must be non-empty. Domain format/ownership validation deferred per [CONV-VALIDATE-API].
    * `certificateType`: if `self`, throw a descriptive error stating self-managed certificates are not yet supported. Any value other than `google` or `self` is invalid.
    * `authorityType`: if `private`, throw a descriptive error stating private certificate authorities are not yet supported. Any value other than `public` or `private` is invalid. While only `public` is supported, this field maps to no Certificate Manager resource field today (authority type is a CA Service / private concern) — it is retained for forward compatibility only and must not be surfaced as a resource argument.
    * `scope`: only `DEFAULT` supported. Any other value throws a descriptive error stating the scope is not yet supported.
    * `authorisationType`: when provided must be `LB` or `DNS`; default `LB`.
      * When `DNS`, `authorisationZone` must be provided (error if missing).
      * When `LB`, `authorisationZone` must not be provided (error if present).
      * When `DNS`, every domain in the cert's parsed `domains` must belong to the single `authorisationZone` (multi-zone certificates are not supported). Validated where resolved; error with a descriptive message otherwise.
    * `certificateMap` hostname uniqueness: across all `certificates` in a map, the combined set of parsed `domains` (hostnames) must be unique — `CertificateMapEntry` hostnames must be unique within a map. Error on collision (validated where resolved).
    * `certificateMap` primary uniqueness: at most one certificate per map may set `primary: true`. Error if more than one.
  * Labels
    * Apply [CONV-LABELS] with module defaults `{ module: "certificate", deployed_by: "pulumi" }`. Applied to Certificate Manager resources only — the classic single certificate (`gcp.compute.ManagedSslCertificate`) does not support labels, so any labels are ignored for that mode.
  * If `certificate` provided (classic managed SSL certificate)
    * Create a single `gcp.compute.ManagedSslCertificate`:
      * `name` = `certificate.name`
      * `description` = `certificate.description` or `"Certificate <name>"`
      * `managed.domains` = parsed list from `certificate.domains`
      * `project` = `project`
    * This certificate is always global, google-managed, public, and validated by the load balancer it is attached to (load-balancer authorization). Location, scope, certificate type, authority type, DNS authorization, and labels do not apply.
  * If `certificateMap` provided (Certificate Manager)
    * Create a `gcp.certificatemanager.CertificateMap`:
      * `name` = `certificateMap.name`
      * `description` = `certificateMap.description` or `"Certificate map <name>"`
      * `labels` = `certificateMap.labels` merged per [CONV-LABELS]
      * `project` = `project`
    * `certificateMap.certificates` must contain at least one entry. For each `<cert_key>`, create a certificate using the internal certificate method (below), passing:
      * `name` = `<cert_key>`
      * `description` = `<cert_key>.description` or `"Certificate <cert_key>"`
      * `location` = `<cert_key>.location` (omitted ⇒ global)
      * `scope` = `<cert_key>.scope` or `DEFAULT`
      * `certificateType` = `<cert_key>.certificateType` or `google`
      * `authorityType` = `<cert_key>.authorityType` or `public`
      * `domains` = `<cert_key>.domains`
      * `authorisationType` = `<cert_key>.authorisationType` or `LB`
      * `authorisationZone` = `<cert_key>.authorisationZone`
      * `labels` = `<cert_key>.labels`, with an additional `{ 'certificate-map': '<certificateMap.name>' }` label appended (module defaults still win on key collision per [CONV-LABELS])
    * `primary` is a map-level concern (not passed to the internal certificate method) — it is read directly from `<cert_key>.primary` when creating the PRIMARY CertificateMapEntry below.
    * For each created certificate, create one `gcp.certificatemanager.CertificateMapEntry` per hostname in that certificate's parsed `domains`:
      * `map` = the created CertificateMap
      * `hostname` = the domain entry
      * `certificates` = [the created Certificate]
      * `name` = deterministic, derived from `<certificateMap.name>`, `<cert_key>` and the hostname. Bounded to GCP's 63-char entry-id limit: when the joined value exceeds 63 chars, truncate and append a short deterministic hash suffix.
    * Additionally, for the certificate whose `<cert_key>.primary` = `true` (if any), create one PRIMARY `gcp.certificatemanager.CertificateMapEntry`:
      * `map` = the created CertificateMap
      * `matcher` = `PRIMARY`
      * `certificates` = [the created Certificate]
      * `name` = deterministic, derived from `<certificateMap.name>` and `<cert_key>`. Bounded to GCP's 63-char entry-id limit: when the joined value exceeds 63 chars, truncate and append a short deterministic hash suffix.
  * Internal certificate method (Certificate Manager `gcp.certificatemanager.Certificate`)
    * Inputs: `name`, `description`, `location`, `scope`, `certificateType`, `authorityType`, `domains`, `authorisationType`, `authorisationZone`, `labels` (resolved and defaulted per the caller above)
    * Requirements
      * Create a `gcp.certificatemanager.Certificate`:
        * `name` = `name`
        * `description` = `description`
        * `location` = `location` (omit ⇒ global)
        * `scope` = `scope` (`DEFAULT`)
        * `project` = `project`
        * `labels` = merged labels per [CONV-LABELS]
        * `managed.domains` = parsed list from `domains`
      * If `authorisationType` = `DNS`
        * For each domain in the parsed list, create a `gcp.certificatemanager.DnsAuthorization` (deterministic name, `domain` = the domain, `location` = `location` or global, `project` = `project`). The DnsAuthorization `location` must match the certificate `location`; use `type` = `PER_PROJECT_RECORD` so authorizations can be reused across certificates in the project.
        * Reference the created DNS authorizations via `managed.dnsAuthorizations` on the certificate
        * Publish each authorization's record into `authorisationZone` by creating a `gcp.dns.RecordSet` (CNAME) in that managed zone using the authorization's `dnsResourceRecord` (name / type / data)
      * If `authorisationType` = `LB`
        * No DNS authorizations are created; the certificate is validated by the load balancer it is attached to
* Return
  * mode — `"certificate" | "certificateMap"` — which mode was created
  * managedCertificateId — `pulumi.Output<string>` — id/self-link of the classic managed SSL certificate (`certificate` mode only)
  * certificateMapId — `pulumi.Output<string>` — resource id of the CertificateMap (`certificateMap` mode only)
  * certificateMapName — `pulumi.Output<string>` — short name of the CertificateMap (`certificateMap` mode only)
  * certificateMapResourceUrl — `pulumi.Output<string>` — the certificate map reference in `//certificatemanager.googleapis.com/projects/<project>/locations/global/certificateMaps/<name>` format; this is the value the `load-balancer` module's `certificateMap` input expects (`certificateMap` mode only)
  * certificateIds — `pulumi.Output<string>[]` — ids of created Certificate Manager certificates (`certificateMap` mode only)
  * dnsAuthorizationRecords — `pulumi.Output<{ name: string; type: string; data: string }>[]` — DNS records created for DNS-authorized certificates (`certificateMap` + `DNS` only)
  * labels — `pulumi.Output<{ [key: string]: string }>` — final merged labels applied to Certificate Manager resources
