import * as crypto from "crypto";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const NAME_REGEX = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Specification for a single classic Google-managed SSL certificate
 * (`gcp.compute.ManagedSslCertificate`).
 *
 * @param name GCP resource name (^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars)
 * @param description Optional description (default: "Certificate <name>")
 * @param domains Comma-separated list of domains served by the certificate
 */
export interface CertificateSpec {
    name: string;
    description?: string;
    domains: string;
}

/**
 * Specification for one certificate within a Certificate Manager certificate map.
 *
 * @param description Optional description (default: "Certificate <cert_key>")
 * @param location Certificate Manager location; omit for a global certificate
 * @param scope Certificate scope; only "DEFAULT" is supported
 * @param certificateType Certificate type; only "google" is supported
 * @param authorityType Authority type; only "public" is supported (forward-compat only)
 * @param domains Comma-separated list of domains served by the certificate
 * @param authorisationType Domain authorisation method: "LB" (default) or "DNS"
 * @param authorisationZone Managed DNS zone name; required when authorisationType is "DNS"
 * @param primary When true, also create a PRIMARY CertificateMapEntry (SNI fallback)
 * @param labels Optional labels, merged per [CONV-LABELS]
 */
export interface CertificateMapCertificateSpec {
    description?: string;
    location?: string;
    scope?: string;
    certificateType?: string;
    authorityType?: string;
    domains: string;
    authorisationType?: string;
    authorisationZone?: pulumi.Input<string>;
    primary?: boolean;
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * Specification for a Certificate Manager certificate map and its certificates.
 *
 * @param name GCP resource name (^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars)
 * @param description Optional description (default: "Certificate map <name>")
 * @param labels Optional labels applied to the CertificateMap, merged per [CONV-LABELS]
 * @param certificates Map of certificate key to specification (at least one entry)
 */
export interface CertificateMapSpec {
    name: string;
    description?: string;
    labels?: pulumi.Input<{ [key: string]: string }>;
    certificates: { [key: string]: CertificateMapCertificateSpec };
}

/**
 * Input arguments for the Certificate module. Exactly one of `certificate` or
 * `certificateMap` must be provided.
 *
 * @param project The GCP project ID string
 * @param certificate A single classic Google-managed SSL certificate (mutually exclusive)
 * @param certificateMap A Certificate Manager certificate map (mutually exclusive)
 */
export interface CertificateArgs {
    project: pulumi.Input<string>;
    certificate?: CertificateSpec;
    certificateMap?: CertificateMapSpec;
}

/**
 * A DNS record that must exist for a DNS-authorized certificate to validate.
 */
export interface DnsAuthorizationRecord {
    name: string;
    type: string;
    data: string;
}

/**
 * A Pulumi ComponentResource that creates either a single classic Google-managed
 * SSL certificate (`gcp.compute.ManagedSslCertificate`) or a Certificate Manager
 * certificate map with one or more managed certificates, their map entries, and
 * (for DNS authorization) DNS authorizations plus the CNAME records that prove them.
 *
 * @param name The unique name of the component resource
 * @param args The certificate creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A Certificate component with registered outputs
 */
export class Certificate extends pulumi.ComponentResource {
    public readonly mode: "certificate" | "certificateMap";
    public readonly managedCertificateId?: pulumi.Output<string>;
    public readonly certificateMapId?: pulumi.Output<string>;
    public readonly certificateMapName?: pulumi.Output<string>;
    public readonly certificateMapResourceUrl?: pulumi.Output<string>;
    public readonly certificateIds?: pulumi.Output<string>[];
    public readonly dnsAuthorizationRecords?: pulumi.Output<DnsAuthorizationRecord>[];
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: CertificateArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Certificate", name, {}, opts);

        this.validateArgs(args);

        if (args.certificate) {
            this.mode = "certificate";

            const spec = args.certificate;
            const cert = new gcp.compute.ManagedSslCertificate(`${name}-cert`, {
                name: spec.name,
                description: spec.description ?? `Certificate ${spec.name}`,
                project: args.project,
                managed: {
                    domains: this.parseDomains(spec.domains),
                },
            }, { parent: this });

            this.managedCertificateId = cert.id;
            // Classic managed SSL certificates do not support labels.
            this.labels = pulumi.output<{ [key: string]: string }>({});
        } else {
            this.mode = "certificateMap";

            const spec = args.certificateMap!;
            const mapLabels = this.mergeLabels(spec.labels);

            const map = new gcp.certificatemanager.CertificateMap(`${name}-map`, {
                name: spec.name,
                description: spec.description ?? `Certificate map ${spec.name}`,
                labels: mapLabels,
                project: args.project,
            }, { parent: this });

            const certificateIds: pulumi.Output<string>[] = [];
            const dnsRecords: pulumi.Output<DnsAuthorizationRecord>[] = [];

            for (const [certKey, certSpec] of Object.entries(spec.certificates)) {
                const domains = this.parseDomains(certSpec.domains);
                const created = this.createManagedCertificate(name, certKey, certSpec, spec.name, args.project);
                certificateIds.push(created.certificateId);
                dnsRecords.push(...created.dnsRecords);

                // One CertificateMapEntry per hostname (SNI selection).
                for (const domain of domains) {
                    const domainSlug = this.slug(domain);
                    new gcp.certificatemanager.CertificateMapEntry(`${name}-${certKey}-${domainSlug}-entry`, {
                        name: this.boundedName(spec.name, certKey, domainSlug),
                        map: map.name,
                        hostname: domain,
                        certificates: [created.certificateId],
                        project: args.project,
                    }, { parent: this });
                }

                // Optional PRIMARY entry (fallback for unmatched SNI).
                if (certSpec.primary) {
                    new gcp.certificatemanager.CertificateMapEntry(`${name}-${certKey}-primary-entry`, {
                        name: this.boundedName(spec.name, certKey, "primary"),
                        map: map.name,
                        matcher: "PRIMARY",
                        certificates: [created.certificateId],
                        project: args.project,
                    }, { parent: this });
                }
            }

            this.certificateMapId = map.id;
            this.certificateMapName = map.name;
            this.certificateMapResourceUrl = pulumi.interpolate`//certificatemanager.googleapis.com/projects/${args.project}/locations/global/certificateMaps/${map.name}`;
            this.certificateIds = certificateIds;
            this.dnsAuthorizationRecords = dnsRecords;
            this.labels = mapLabels;
        }

        this.registerOutputs({
            mode: this.mode,
            managedCertificateId: this.managedCertificateId,
            certificateMapId: this.certificateMapId,
            certificateMapName: this.certificateMapName,
            certificateMapResourceUrl: this.certificateMapResourceUrl,
            certificateIds: this.certificateIds,
            dnsAuthorizationRecords: this.dnsAuthorizationRecords,
            labels: this.labels,
        });
    }

    /**
     * Creates a single Certificate Manager managed certificate, and — when DNS
     * authorized — its DNS authorizations and the CNAME records that prove them.
     * CertificateMapEntry resources are created by the caller (map-level concern).
     *
     * @param componentName The component resource name (used for child resource names)
     * @param certKey The certificate key within the map (used as the GCP certificate name)
     * @param spec The certificate specification
     * @param mapName The parent certificate map name (used for the certificate-map label)
     * @param project The GCP project ID
     * @returns The created certificate id and any DNS authorization records
     */
    private createManagedCertificate(
        componentName: string,
        certKey: string,
        spec: CertificateMapCertificateSpec,
        mapName: string,
        project: pulumi.Input<string>,
    ): { certificateId: pulumi.Output<string>; dnsRecords: pulumi.Output<DnsAuthorizationRecord>[] } {
        const domains = this.parseDomains(spec.domains);
        const location = spec.location ?? "global";
        const scope = spec.scope ?? "DEFAULT";
        const authorisationType = (spec.authorisationType ?? "LB").toUpperCase();
        const labels = this.mergeLabels(
            pulumi.output(spec.labels ?? {}).apply(l => ({ ...l, "certificate-map": mapName })),
        );

        const dnsRecords: pulumi.Output<DnsAuthorizationRecord>[] = [];
        let dnsAuthorizationIds: pulumi.Output<string>[] | undefined;

        if (authorisationType === "DNS") {
            dnsAuthorizationIds = [];
            for (const domain of domains) {
                const domainSlug = this.slug(domain);
                const auth = new gcp.certificatemanager.DnsAuthorization(`${componentName}-${certKey}-${domainSlug}-auth`, {
                    name: `${certKey}-${domainSlug}-auth`,
                    domain: domain,
                    location: location,
                    type: "PER_PROJECT_RECORD",
                    project: project,
                }, { parent: this });
                dnsAuthorizationIds.push(auth.id);

                const record = auth.dnsResourceRecords[0];
                new gcp.dns.RecordSet(`${componentName}-${certKey}-${domainSlug}-record`, {
                    name: record.name,
                    type: record.type,
                    managedZone: spec.authorisationZone!,
                    rrdatas: [record.data],
                    ttl: 300,
                    project: project,
                }, { parent: this });

                dnsRecords.push(pulumi.output({
                    name: record.name,
                    type: record.type,
                    data: record.data,
                }));
            }
        }

        const cert = new gcp.certificatemanager.Certificate(`${componentName}-${certKey}`, {
            name: certKey,
            description: spec.description ?? `Certificate ${certKey}`,
            location: location,
            scope: scope,
            labels: labels,
            project: project,
            managed: {
                domains: domains,
                ...(dnsAuthorizationIds ? { dnsAuthorizations: dnsAuthorizationIds } : {}),
            },
        }, { parent: this });

        return { certificateId: cert.id, dnsRecords };
    }

    /**
     * Parses a comma-separated domains string into a trimmed, non-empty list.
     *
     * @param domains The comma-separated domains string
     * @returns The parsed list of domains
     */
    private parseDomains(domains: string): string[] {
        const parsed = domains.split(",").map(d => d.trim()).filter(d => d.length > 0);
        if (parsed.length === 0) {
            throw new Error("'domains' must contain at least one non-empty domain.");
        }
        return parsed;
    }

    /**
     * Converts a hostname into a resource-name-safe slug.
     *
     * @param value The hostname (may contain dots or a wildcard)
     * @returns A slug of lowercase alphanumerics separated by hyphens
     */
    private slug(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    }

    /**
     * Produces a deterministic CertificateMapEntry id bounded to 63 characters.
     * GCP entry ids allow lowercase letters, digits and hyphens (max 63). When the
     * joined parts exceed the limit, truncate and append a short hash of the full
     * value so the id stays unique and stable across runs.
     *
     * @param parts The name segments to join with hyphens
     * @returns A resource id of at most 63 characters
     */
    private boundedName(...parts: string[]): string {
        const raw = parts.join("-");
        if (raw.length <= 63) {
            return raw;
        }
        const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
        const head = raw.slice(0, 63 - hash.length - 1).replace(/-+$/g, "");
        return `${head}-${hash}`;
    }

    /**
     * Merges user labels with module defaults and validates per [CONV-LABELS].
     * Module defaults win on key collision.
     *
     * @param userLabels Optional user-provided labels
     * @returns The validated, merged label map
     */
    private mergeLabels(userLabels?: pulumi.Input<{ [key: string]: string }>): pulumi.Output<{ [key: string]: string }> {
        return pulumi.output(userLabels ?? {}).apply(u => {
            const merged: { [key: string]: string } = {
                ...(u ?? {}),
                module: "certificate",
                deployed_by: "pulumi",
            };

            const labelKeyRegex = /^[a-z][a-z0-9_-]*$/;
            const labelValueRegex = /^[a-z0-9_-]*$/;
            for (const [key, value] of Object.entries(merged)) {
                if (key.length > 63 || !labelKeyRegex.test(key)) {
                    throw new Error(
                        `Invalid label key '${key}'. Keys must be lowercase letters, digits, underscores, or hyphens, start with a lowercase letter, and be max 63 characters.`
                    );
                }
                if (value.length > 63 || !labelValueRegex.test(value)) {
                    throw new Error(
                        `Invalid label value '${value}' for key '${key}'. Values must be lowercase letters, digits, underscores, or hyphens and be max 63 characters.`
                    );
                }
            }

            return merged;
        });
    }

    /**
     * Validates the input arguments. Syntax-level validation only at construction
     * time; unresolved Outputs are skipped, and existence/ownership is deferred to
     * the GCP API at apply time.
     *
     * @param args The certificate arguments to validate
     */
    private validateArgs(args: CertificateArgs): void {
        if (!args.certificate === !args.certificateMap) {
            throw new Error("Exactly one of 'certificate' or 'certificateMap' must be provided.");
        }

        if (typeof args.project === "string") {
            if (!args.project) {
                throw new Error("'project' must be provided.");
            }
            if (/^\d+$/.test(args.project)) {
                throw new Error(
                    `'project' must be a GCP project ID string (e.g. 'my-project-a1b2'), not a numeric project number. Got '${args.project}'.`
                );
            }
        }

        if (args.certificate) {
            this.validateName(args.certificate.name, "certificate.name");
            this.parseDomains(args.certificate.domains);
            return;
        }

        const spec = args.certificateMap!;
        this.validateName(spec.name, "certificateMap.name");

        const keys = Object.keys(spec.certificates ?? {});
        if (keys.length === 0) {
            throw new Error("'certificateMap.certificates' must contain at least one entry.");
        }

        const seenHostnames = new Set<string>();
        let primaryCount = 0;

        for (const key of keys) {
            const certSpec = spec.certificates[key];
            this.validateName(key, `certificateMap.certificates.${key}`);

            const domains = this.parseDomains(certSpec.domains);
            for (const domain of domains) {
                if (seenHostnames.has(domain)) {
                    throw new Error(
                        `Duplicate hostname '${domain}' across certificates in map '${spec.name}'. CertificateMapEntry hostnames must be unique within a map.`
                    );
                }
                seenHostnames.add(domain);
            }

            if (certSpec.certificateType !== undefined) {
                if (certSpec.certificateType === "self") {
                    throw new Error("Self-managed certificates (certificateType: self) are not yet supported.");
                }
                if (certSpec.certificateType !== "google") {
                    throw new Error(
                        `'certificateType' must be 'google' or 'self'. Got '${certSpec.certificateType}'.`
                    );
                }
            }

            if (certSpec.authorityType !== undefined) {
                if (certSpec.authorityType === "private") {
                    throw new Error("Private certificate authorities (authorityType: private) are not yet supported.");
                }
                if (certSpec.authorityType !== "public") {
                    throw new Error(
                        `'authorityType' must be 'public' or 'private'. Got '${certSpec.authorityType}'.`
                    );
                }
            }

            if (certSpec.scope !== undefined && certSpec.scope !== "DEFAULT") {
                throw new Error(`'scope' only supports 'DEFAULT' at this time. Got '${certSpec.scope}'.`);
            }

            const authorisationType = certSpec.authorisationType ?? "LB";
            if (authorisationType !== "LB" && authorisationType !== "DNS") {
                throw new Error(`'authorisationType' must be 'LB' or 'DNS'. Got '${certSpec.authorisationType}'.`);
            }
            if (authorisationType === "DNS" && certSpec.authorisationZone === undefined) {
                throw new Error(
                    `'authorisationZone' must be provided when authorisationType is 'DNS' (certificate '${key}').`
                );
            }
            if (authorisationType === "LB" && certSpec.authorisationZone !== undefined) {
                throw new Error(
                    `'authorisationZone' must not be provided when authorisationType is 'LB' (certificate '${key}').`
                );
            }
            // Single-zone constraint (all domains belong to authorisationZone) is
            // deferred to the GCP API — the zone's DNS suffix is not known here.

            if (certSpec.primary) {
                primaryCount++;
            }
        }

        if (primaryCount > 1) {
            throw new Error(`At most one certificate per map may set 'primary: true'. Map '${spec.name}' has ${primaryCount}.`);
        }
    }

    /**
     * Validates a GCP resource name against the standard name pattern.
     *
     * @param value The name to validate
     * @param field The field label used in error messages
     */
    private validateName(value: string, field: string): void {
        if (!value) {
            throw new Error(`'${field}' must be provided.`);
        }
        if (value.length > 63 || !NAME_REGEX.test(value)) {
            throw new Error(
                `'${field}' must match ^[a-z]([-a-z0-9]*[a-z0-9])?$ and be max 63 characters. Got '${value}'.`
            );
        }
    }
}
