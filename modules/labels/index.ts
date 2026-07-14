import * as pulumi from "@pulumi/pulumi";

/**
 * Input arguments for the Labels module.
 *
 * @param labels A flat map of label key-value pairs (at least one entry required)
 */
export interface LabelsArgs {
    labels: { [key: string]: string };
}

/**
 * A Pulumi ComponentResource that sanitises labels into GCP-compliant format.
 * Applies lowercase conversion, special character replacement, key prefix correction,
 * and truncation to ensure all labels meet GCP requirements.
 *
 * @param name The unique name of the component resource
 * @param args The label sanitisation arguments
 * @param opts Optional Pulumi resource options
 * @returns A Labels component with sanitised labels as an output
 */
export class Labels extends pulumi.ComponentResource {
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: LabelsArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Labels", name, {}, opts);

        if (!args.labels || Object.keys(args.labels).length === 0) {
            throw new Error("Labels input must contain at least one entry.");
        }

        const sanitised: { [key: string]: string } = {};

        for (const [rawKey, rawValue] of Object.entries(args.labels)) {
            const key = this.sanitiseKey(rawKey);
            const value = this.sanitiseValue(rawValue);
            sanitised[key] = value;
        }

        this.labels = pulumi.output(sanitised);

        this.registerOutputs({
            labels: this.labels,
        });
    }

    /**
     * Sanitises a label key: lowercase, replace invalid chars, ensure starts with [a-z], truncate.
     *
     * @param raw The raw label key
     * @returns The sanitised label key
     */
    private sanitiseKey(raw: string): string {
        let key = raw.toLowerCase();
        key = key.replace(/[^a-z0-9_-]/g, "_");

        if (!/^[a-z]/.test(key)) {
            key = `l_${key}`;
        }

        key = key.substring(0, 63);

        if (key.length === 0) {
            throw new Error(`Label key is empty after sanitisation. Original: "${raw}"`);
        }

        return key;
    }

    /**
     * Sanitises a label value: lowercase, replace invalid chars, truncate.
     *
     * @param raw The raw label value
     * @returns The sanitised label value
     */
    private sanitiseValue(raw: string): string {
        let value = raw.toLowerCase();
        value = value.replace(/[^a-z0-9_-]/g, "_");
        value = value.substring(0, 63);
        return value;
    }
}
