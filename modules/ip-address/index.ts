import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * External IP address type configuration.
 *
 * @param ipVersion IPv4 or IPv6 (default: IPv4)
 * @param type Regional or Global
 * @param region GCP region, required when type is Regional
 */
export interface IpAddressExternalArgs {
    ipVersion?: string;
    type: string;
    region?: string;
}

/**
 * Type discriminator for IP address reservation.
 * Currently only external is supported.
 *
 * @param external External IP address configuration
 */
export interface IpAddressTypeArgs {
    external?: IpAddressExternalArgs;
}

/**
 * Input arguments for the IpAddress module.
 *
 * @param name GCP resource name prefix
 * @param project GCP project ID string
 * @param description Optional description (default: "IP Address <name>")
 * @param type IP address type configuration (external only)
 * @param labels Optional labels merged with module defaults
 */
export interface IpAddressArgs {
    name: pulumi.Input<string>;
    project: pulumi.Input<string>;
    description?: pulumi.Input<string>;
    type: IpAddressTypeArgs;
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCP IP address reservation.
 * Supports external Regional and Global addresses.
 *
 * @param name The unique name of the component resource
 * @param args The IP address creation arguments
 * @param opts Optional Pulumi resource options
 * @returns An IpAddress component with registered outputs
 */
export class IpAddress extends pulumi.ComponentResource {
    public readonly address: pulumi.Output<string>;
    public readonly name: pulumi.Output<string>;
    public readonly selfLink: pulumi.Output<string>;
    public readonly addressType: pulumi.Output<string>;
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: IpAddressArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:IpAddress", name, {}, opts);

        this.validateArgs(args);

        const external = args.type.external!;
        const ipVersion = external.ipVersion ?? "IPv4";
        const scope = external.type;

        const resolvedDescription = args.description
            ? pulumi.output(args.description)
            : pulumi.interpolate`IP Address ${args.name}`;

        const mergedLabels = pulumi.output(args.labels || {}).apply(l => {
            const merged: { [key: string]: string } = {
                ...l,
                module: "ip-address",
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

        if (scope === "Global") {
            const globalAddress = new gcp.compute.GlobalAddress(`${name}-address`, {
                name: args.name,
                project: args.project,
                description: resolvedDescription,
                addressType: "EXTERNAL",
                ipVersion: ipVersion === "IPv6" ? "IPV6" : "IPV4",
                labels: mergedLabels,
            }, { parent: this });

            this.address = globalAddress.address;
            this.name = globalAddress.name;
            this.selfLink = globalAddress.selfLink;
        } else {
            const regionalAddress = new gcp.compute.Address(`${name}-address`, {
                name: args.name,
                project: args.project,
                description: resolvedDescription,
                addressType: "EXTERNAL",
                region: external.region,
                networkTier: "PREMIUM",
                labels: mergedLabels,
            }, { parent: this });

            this.address = regionalAddress.address;
            this.name = regionalAddress.name;
            this.selfLink = regionalAddress.selfLink;
        }

        this.addressType = pulumi.output("EXTERNAL");
        this.labels = mergedLabels;

        this.registerOutputs({
            address: this.address,
            name: this.name,
            selfLink: this.selfLink,
            addressType: this.addressType,
            labels: this.labels,
        });
    }

    /**
     * Validates the input arguments for the IpAddress module.
     * Syntax-level validation only at construction time.
     *
     * @param args The IP address arguments to validate
     */
    private validateArgs(args: IpAddressArgs): void {
        if (typeof args.name === "string") {
            const nameRegex = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
            if (args.name.length > 63 || !nameRegex.test(args.name)) {
                throw new Error(
                    `Name must match ^[a-z]([-a-z0-9]*[a-z0-9])?$ and be max 63 characters. Got '${args.name}'.`
                );
            }
        }

        if (!args.type) {
            throw new Error("'type' must be provided.");
        }

        const typeKeys = Object.keys(args.type).filter(k => (args.type as any)[k] != null);
        if (typeKeys.length === 0) {
            throw new Error("Exactly one of 'external' must be provided in 'type'.");
        }
        if (typeKeys.length > 1) {
            throw new Error(`Exactly one of 'external' must be provided in 'type'. Got: ${typeKeys.join(", ")}.`);
        }
        if (!args.type.external) {
            throw new Error("Only 'external' type is currently supported.");
        }

        const external = args.type.external;
        const validTypes = ["Regional", "Global"];
        if (!external.type || !validTypes.includes(external.type)) {
            throw new Error(
                `'type.external.type' must be one of ${validTypes.join(", ")}. Got '${external.type}'.`
            );
        }

        if (external.type === "Regional" && !external.region) {
            throw new Error("'type.external.region' is required when type.external.type is 'Regional'.");
        }
        if (external.type === "Global" && external.region) {
            throw new Error("'type.external.region' must not be provided when type.external.type is 'Global'.");
        }

        if (external.ipVersion != null) {
            const validVersions = ["IPv4", "IPv6"];
            if (!validVersions.includes(external.ipVersion)) {
                throw new Error(
                    `'type.external.ipVersion' must be one of ${validVersions.join(", ")}. Got '${external.ipVersion}'.`
                );
            }
        }
    }
}
