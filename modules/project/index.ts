import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as random from "@pulumi/random";
import { Iam } from "../iam";

/**
 * Input arguments for the Project module.
 * Exactly one of organisation or folder must be provided as the parent.
 *
 * @param organisation The parent organisation numeric ID
 * @param folder The parent folder numeric ID
 * @param billing The billing account ID (format: XXXXXX-XXXXXX-XXXXXX)
 * @param name The project name (used as display name and project ID base, 1-25 chars)
 * @param apis List of GCP APIs to enable (at least one required)
 * @param bindings Optional IAM bindings to apply to the created project
 * @param labels Optional labels to apply to the project (merged with default module: project)
 */
export interface ProjectArgs {
    organisation?: pulumi.Input<string>;
    folder?: pulumi.Input<string>;
    billing: pulumi.Input<string>;
    name: string;
    apis: string[];
    bindings?: {
        [roleId: string]: pulumi.Input<string>[];
    };
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCP project with APIs enabled,
 * default service accounts deleted, and optional IAM bindings and labels.
 *
 * @param name The unique name of the component resource
 * @param args The project creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A Project component with registered outputs
 */
export class Project extends pulumi.ComponentResource {
    public readonly projectDisplayName: pulumi.Output<string>;
    public readonly projectId: pulumi.Output<string>;
    public readonly projectNumber: pulumi.Output<string>;
    public readonly bindings: pulumi.Output<{ [roleId: string]: string[] } | null>;
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: ProjectArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Project", name, {}, opts);

        this.validateArgs(args);

        const apis = [...args.apis];
        if (!apis.includes("compute.googleapis.com")) {
            apis.push("compute.googleapis.com");
        }

        const postfix = new random.RandomId(`${name}-postfix`, {
            byteLength: 2,
            keepers: {
                name: args.name,
            },
        }, { parent: this });

        const projectId = pulumi.interpolate`${args.name}-${postfix.hex}`;

        const mergedLabels = pulumi.output(args.labels || {}).apply(l => {
            const merged: { [key: string]: string } = {
                ...l,
                module: "project",
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

        const project = new gcp.organizations.Project(`${name}-project`, {
            name: args.name,
            projectId: projectId,
            orgId: args.organisation,
            folderId: args.folder,
            billingAccount: args.billing,
            autoCreateNetwork: false,
            labels: mergedLabels,
        }, { parent: this });

        const serviceResources: gcp.projects.Service[] = [];
        for (const api of apis) {
            const service = new gcp.projects.Service(`${name}-api-${api.replace(/\./g, "-")}`, {
                project: project.projectId,
                service: api,
                disableOnDestroy: false,
            }, { parent: this });
            serviceResources.push(service);
        }

        new gcp.projects.DefaultServiceAccounts(`${name}-default-sa`, {
            project: project.projectId,
            action: "DELETE",
        }, { parent: this, dependsOn: serviceResources });

        if (args.bindings && Object.keys(args.bindings).length > 0) {
            new Iam(`${name}-iam`, {
                project: project.projectId,
                bindings: args.bindings,
            }, { parent: this });
        }

        this.projectDisplayName = pulumi.output(args.name);
        this.projectId = project.projectId;
        this.projectNumber = project.number;
        this.bindings = pulumi.output(
            args.bindings
                ? Object.fromEntries(
                      Object.entries(args.bindings).map(([role, principals]) => [role, principals as string[]])
                  )
                : null
        );
        this.labels = mergedLabels;

        this.registerOutputs({
            projectDisplayName: this.projectDisplayName,
            projectId: this.projectId,
            projectNumber: this.projectNumber,
            bindings: this.bindings,
            labels: this.labels,
        });
    }

    /**
     * Validates the input arguments for the Project module.
     * Syntax-level validation only at construction time.
     * Resource existence and billing validation deferred to GCP APIs at apply time.
     *
     * @param args The project arguments to validate
     */
    private validateArgs(args: ProjectArgs): void {
        const nameRegex = /^[a-z][a-z0-9-]*[a-z0-9]$/;

        if (!args.name || args.name.length < 1 || args.name.length > 25) {
            throw new Error(
                `Project name must be between 1 and 25 characters. Got ${args.name ? args.name.length : 0} characters.`
            );
        }

        if (args.name.length === 1) {
            if (!/^[a-z]$/.test(args.name)) {
                throw new Error(
                    `Project name must start with a lowercase letter. Got '${args.name}'.`
                );
            }
        } else if (!nameRegex.test(args.name)) {
            throw new Error(
                `Project name must contain only lowercase letters, digits, and hyphens, must start with a letter, and cannot end with a hyphen. Got '${args.name}'.`
            );
        }

        const targets = [args.organisation, args.folder].filter(
            (t) => t !== undefined && t !== null
        );

        if (targets.length === 0) {
            throw new Error("Exactly one of 'organisation' or 'folder' must be provided. None were provided.");
        }

        if (targets.length > 1) {
            throw new Error("Exactly one of 'organisation' or 'folder' must be provided. More than one was provided.");
        }

        if (!args.apis || args.apis.length === 0) {
            throw new Error("'apis' must contain at least one entry.");
        }

    }
}
