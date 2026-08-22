import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * Input arguments for the DnsZone module.
 *
 * @param zoneName The DNS zone resource name (1-63 chars, lowercase letters/digits/hyphens, must start with a letter, must not end with a hyphen)
 * @param dnsName The DNS name for the zone (FQDN, trailing dot auto-appended if missing)
 * @param description Optional description for the DNS zone
 * @param visibility Zone visibility: "public" (default) or "private" (not yet supported)
 * @param project The GCP project ID string
 * @param labels Optional GCP resource labels (merged with module defaults)
 */
export interface DnsZoneArgs {
    zoneName: pulumi.Input<string>;
    dnsName: pulumi.Input<string>;
    description?: pulumi.Input<string>;
    visibility?: string;
    project: pulumi.Input<string>;
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCP Cloud DNS managed zone.
 *
 * @param name The unique name of the component resource
 * @param args The DNS zone creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A DnsZone component with registered outputs
 */
export class DnsZone extends pulumi.ComponentResource {
    public readonly zoneName: pulumi.Output<string>;
    public readonly dnsName: pulumi.Output<string>;
    public readonly nameServers: pulumi.Output<string[]>;
    public readonly managedZoneId: pulumi.Output<string>;
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: DnsZoneArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:DnsZone", name, {}, opts);

        this.validateArgs(args);

        const visibility = args.visibility ?? "public";

        const resolvedDnsName = pulumi.output(args.dnsName).apply(dns => {
            return dns.endsWith(".") ? dns : `${dns}.`;
        });

        const mergedLabels = pulumi.output(args.labels || {}).apply(l => {
            const merged: { [key: string]: string } = {
                ...l,
                module: "dns-zone",
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

        const zone = new gcp.dns.ManagedZone(`${name}-zone`, {
            name: args.zoneName,
            dnsName: resolvedDnsName,
            description: args.description ?? "",
            visibility: visibility,
            project: args.project,
            labels: mergedLabels,
        }, { parent: this });

        this.zoneName = zone.name;
        this.dnsName = zone.dnsName;
        this.nameServers = zone.nameServers;
        this.managedZoneId = zone.managedZoneId;
        this.labels = mergedLabels;

        this.registerOutputs({
            zoneName: this.zoneName,
            dnsName: this.dnsName,
            nameServers: this.nameServers,
            managedZoneId: this.managedZoneId,
            labels: this.labels,
        });
    }

    /**
     * Validates the input arguments for the DnsZone module.
     * Syntax-level validation only at construction time.
     * Unresolved Outputs are skipped.
     *
     * @param args The DNS zone arguments to validate
     */
    private validateArgs(args: DnsZoneArgs): void {
        const zoneNameRegex = /^[a-z][a-z0-9-]*[a-z0-9]$/;

        if (typeof args.zoneName === "string") {
            if (!args.zoneName) {
                throw new Error("'zoneName' must be provided.");
            }
            if (args.zoneName.length < 1 || args.zoneName.length > 63) {
                throw new Error(
                    `'zoneName' must be between 1 and 63 characters. Got ${args.zoneName.length} characters.`
                );
            }
            if (args.zoneName.length === 1) {
                if (!/^[a-z]$/.test(args.zoneName)) {
                    throw new Error(
                        `'zoneName' must start with a lowercase letter. Got '${args.zoneName}'.`
                    );
                }
            } else if (!zoneNameRegex.test(args.zoneName)) {
                throw new Error(
                    `'zoneName' must contain only lowercase letters, digits, and hyphens, must start with a lowercase letter, and must not end with a hyphen. Got '${args.zoneName}'.`
                );
            }
        }

        if (typeof args.dnsName === "string") {
            if (!args.dnsName) {
                throw new Error("'dnsName' must be provided.");
            }
            const normalized = args.dnsName.endsWith(".") ? args.dnsName.slice(0, -1) : args.dnsName;
            if (!normalized.includes(".")) {
                throw new Error(
                    `'dnsName' must be a valid FQDN with at least one dot (e.g. 'service.mydomain.com'). Got '${args.dnsName}'.`
                );
            }
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

        if (args.visibility !== undefined) {
            const v = args.visibility.toLowerCase();
            if (v === "private") {
                throw new Error("Private DNS zones are not yet supported.");
            }
            if (v !== "public") {
                throw new Error(
                    `'visibility' must be 'public' or 'private'. Got '${args.visibility}'.`
                );
            }
        }
    }
}
