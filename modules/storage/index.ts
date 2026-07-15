import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";
import { Iam } from "../iam";

/**
 * Input arguments for the Storage module.
 * Exactly one of location, locationDual, or locationMulti must be provided.
 *
 * @param name The storage bucket name (3-63 chars, or 3-58 if postfix is true)
 * @param postfix Whether to append a random 4-char hex postfix to the bucket name
 * @param project The GCP project ID string to create the bucket in
 * @param location A single GCP region (mutually exclusive with locationDual and locationMulti)
 * @param locationDual A list of exactly 2 GCP regions for dual-region (mutually exclusive)
 * @param locationMulti One of US, EU, or ASIA for multi-region (mutually exclusive)
 * @param storageClass The storage class (STANDARD, NEARLINE, COLDLINE, ARCHIVE)
 * @param uniformAccess Whether to enable uniform bucket-level access
 * @param versioning Whether to enable object versioning
 * @param bindings Optional IAM bindings to apply to the bucket
 * @param labels Optional labels to apply to the bucket (merged with module defaults)
 */
export interface StorageArgs {
    name: string;
    postfix?: boolean;
    project: pulumi.Input<string>;
    location?: string;
    locationDual?: string[];
    locationMulti?: string;
    storageClass?: string;
    uniformAccess?: boolean;
    versioning?: boolean;
    bindings?: {
        [roleId: string]: pulumi.Input<string>[];
    };
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCS storage bucket with optional
 * postfix, uniform access, versioning, IAM bindings, and labels.
 *
 * @param name The unique name of the component resource
 * @param args The storage bucket creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A Storage component with registered outputs
 */
export class Storage extends pulumi.ComponentResource {
    public readonly bucketName: pulumi.Output<string>;
    public readonly location: pulumi.Output<string>;
    public readonly uniformAccess: pulumi.Output<boolean>;
    public readonly versioning: pulumi.Output<boolean>;
    public readonly bindings: pulumi.Output<{ [roleId: string]: string[] } | null>;
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: StorageArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Storage", name, {}, opts);

        this.validateArgs(args);

        const usePostfix = args.postfix ?? false;
        const uniformAccess = args.uniformAccess ?? true;
        const versioning = args.versioning ?? true;
        const storageClass = args.storageClass?.toUpperCase() ?? "STANDARD";

        let bucketName: pulumi.Output<string>;

        if (usePostfix) {
            const postfix = new random.RandomId(`${name}-postfix`, {
                byteLength: 2,
                keepers: {
                    name: args.name,
                },
            }, { parent: this });

            bucketName = pulumi.interpolate`${args.name}-${postfix.hex}`;
        } else {
            bucketName = pulumi.output(args.name);
        }

        const resolvedLocation = this.resolveLocation(args);

        const mergedLabels = pulumi.output(args.labels || {}).apply(l => {
            const merged: { [key: string]: string } = {
                ...l,
                module: "storage",
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

        const bucket = new gcp.storage.Bucket(`${name}-bucket`, {
            name: bucketName,
            project: args.project,
            location: resolvedLocation,
            storageClass: storageClass,
            uniformBucketLevelAccess: uniformAccess,
            versioning: {
                enabled: versioning,
            },
            labels: mergedLabels,
        }, { parent: this });

        if (args.bindings && Object.keys(args.bindings).length > 0) {
            new Iam(`${name}-iam`, {
                resource: {
                    type: "storage",
                    identifier: bucket.name,
                },
                bindings: args.bindings,
            }, { parent: this });
        }

        this.bucketName = bucket.name;
        this.location = bucket.location;
        this.uniformAccess = pulumi.output(uniformAccess);
        this.versioning = pulumi.output(versioning);
        this.bindings = pulumi.output(
            args.bindings
                ? Object.fromEntries(
                      Object.entries(args.bindings).map(([role, principals]) => [role, principals as string[]])
                  )
                : null
        );
        this.labels = mergedLabels;

        this.registerOutputs({
            bucketName: this.bucketName,
            location: this.location,
            uniformAccess: this.uniformAccess,
            versioning: this.versioning,
            bindings: this.bindings,
            labels: this.labels,
        });
    }

    /**
     * Resolves the bucket location from the mutually exclusive location args.
     * Returns the GCS-compatible location string.
     *
     * @param args The storage arguments containing location fields
     * @returns The resolved location string
     */
    private resolveLocation(args: StorageArgs): string {
        if (args.location) {
            return args.location;
        }
        if (args.locationDual) {
            return `${args.locationDual[0]}+${args.locationDual[1]}`;
        }
        return args.locationMulti!.toUpperCase();
    }

    /**
     * Validates the input arguments for the Storage module.
     * Syntax-level validation only at construction time.
     * Resource existence validation deferred to GCP APIs at apply time.
     *
     * @param args The storage arguments to validate
     */
    private validateArgs(args: StorageArgs): void {
        const usePostfix = args.postfix ?? false;
        const maxNameLength = usePostfix ? 58 : 63;
        const nameRegex = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/;

        if (!args.name || args.name.length < 3 || args.name.length > maxNameLength) {
            throw new Error(
                `Bucket name must be between 3 and ${maxNameLength} characters. Got ${args.name ? args.name.length : 0} characters.`
            );
        }

        if (args.name.length < 3 || !nameRegex.test(args.name)) {
            throw new Error(
                `Bucket name must contain only lowercase letters, digits, hyphens, underscores, and dots, and must start and end with a lowercase letter or digit. Got '${args.name}'.`
            );
        }

        if (args.name.startsWith("goog") || args.name.includes("google")) {
            throw new Error(
                `Bucket name must not contain the prefix 'goog' or the string 'google'. Got '${args.name}'.`
            );
        }

        const locationTargets = [args.location, args.locationDual, args.locationMulti].filter(
            (t) => t !== undefined && t !== null
        );

        if (locationTargets.length === 0) {
            throw new Error("Exactly one of 'location', 'locationDual', or 'locationMulti' must be provided. None were provided.");
        }

        if (locationTargets.length > 1) {
            throw new Error("Exactly one of 'location', 'locationDual', or 'locationMulti' must be provided. More than one was provided.");
        }

        if (args.locationDual) {
            if (args.locationDual.length !== 2) {
                throw new Error(
                    `'locationDual' must contain exactly 2 regions. Got ${args.locationDual.length}.`
                );
            }
        }

        if (args.locationMulti) {
            const valid = ["US", "EU", "ASIA"];
            if (!valid.includes(args.locationMulti.toUpperCase())) {
                throw new Error(
                    `'locationMulti' must be one of: US, EU, ASIA. Got '${args.locationMulti}'.`
                );
            }
        }

        if (args.storageClass) {
            const validClasses = ["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"];
            if (!validClasses.includes(args.storageClass.toUpperCase())) {
                throw new Error(
                    `'storageClass' must be one of: STANDARD, NEARLINE, COLDLINE, ARCHIVE. Got '${args.storageClass}'.`
                );
            }
        }
    }
}
