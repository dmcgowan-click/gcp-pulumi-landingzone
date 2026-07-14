import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * Input arguments for the IAM module.
 * Exactly one of organisation, folder, project, or resource must be provided.
 *
 * @param organisation The organisation ID to bind IAM roles to
 * @param folder The folder ID to bind IAM roles to
 * @param project The project ID to bind IAM roles to
 * @param resource The resource to bind IAM roles to (type + identifier)
 * @param bindings A map of role IDs to lists of principals
 */
export interface IamArgs {
    organisation?: pulumi.Input<string>;
    folder?: pulumi.Input<string>;
    project?: pulumi.Input<string>;
    resource?: {
        type: string;
        identifier: pulumi.Input<string>;
    };
    bindings: {
        [roleId: string]: pulumi.Input<string>[];
    };
}

/**
 * A Pulumi ComponentResource that manages non-authoritative IAM member bindings.
 * Supports organisation, folder, project, storage bucket, and service account targets.
 *
 * @param name The unique name of the component resource
 * @param args The IAM binding arguments
 * @param opts Optional Pulumi resource options
 */
export class Iam extends pulumi.ComponentResource {
    public readonly organisation: pulumi.Output<string | null>;
    public readonly folder: pulumi.Output<string | null>;
    public readonly project: pulumi.Output<string | null>;
    public readonly resource: pulumi.Output<{ type: string; identifier: string } | null>;
    public readonly bindings: pulumi.Output<{ [roleId: string]: string[] }>;

    constructor(name: string, args: IamArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Iam", name, {}, opts);

        this.validateArgs(args);

        for (const [roleId, principals] of Object.entries(args.bindings)) {
            for (const principal of principals) {
                const resourceName = `${name}-${roleId}-${principal}`.replace(/[/:]/g, "-");

                if (args.organisation) {
                    new gcp.organizations.IAMMember(resourceName, {
                        orgId: args.organisation,
                        role: roleId,
                        member: principal,
                    }, { parent: this });
                } else if (args.folder) {
                    new gcp.folder.IAMMember(resourceName, {
                        folder: args.folder,
                        role: roleId,
                        member: principal,
                    }, { parent: this });
                } else if (args.project) {
                    new gcp.projects.IAMMember(resourceName, {
                        project: args.project,
                        role: roleId,
                        member: principal,
                    }, { parent: this });
                } else if (args.resource) {
                    if (args.resource.type === "storage") {
                        new gcp.storage.BucketIAMMember(resourceName, {
                            bucket: args.resource.identifier,
                            role: roleId,
                            member: principal,
                        }, { parent: this });
                    } else if (args.resource.type === "service_account") {
                        new gcp.serviceaccount.IAMMember(resourceName, {
                            serviceAccountId: args.resource.identifier,
                            role: roleId,
                            member: principal,
                        }, { parent: this });
                    }
                }
            }
        }

        this.organisation = pulumi.output(args.organisation ?? null);
        this.folder = pulumi.output(args.folder ?? null);
        this.project = pulumi.output(args.project ?? null);
        this.resource = pulumi.output(
            args.resource
                ? { type: args.resource.type, identifier: args.resource.identifier }
                : null
        );
        this.bindings = pulumi.output(
            Object.fromEntries(
                Object.entries(args.bindings).map(([role, principals]) => [role, principals as string[]])
            )
        );

        this.registerOutputs({
            organisation: this.organisation,
            folder: this.folder,
            project: this.project,
            resource: this.resource,
            bindings: this.bindings,
        });
    }

    /**
     * Validates the input arguments for the IAM module.
     * Syntax-level validation only — verifies format and required fields.
     * Resource existence is deferred to GCP APIs at apply time.
     *
     * @param args The IAM binding arguments to validate
     */
    private validateArgs(args: IamArgs): void {
        const targets = [args.organisation, args.folder, args.project, args.resource].filter(
            (t) => t !== undefined && t !== null
        );

        if (targets.length === 0) {
            throw new Error("Exactly one of 'organisation', 'folder', 'project', or 'resource' must be provided. None were provided.");
        }

        if (targets.length > 1) {
            throw new Error("Exactly one of 'organisation', 'folder', 'project', or 'resource' must be provided. More than one was provided.");
        }

        if (args.resource) {
            if (args.resource.type !== "storage" && args.resource.type !== "service_account") {
                throw new Error(`Unsupported resource type '${args.resource.type}'. Must be one of: storage, service_account`);
            }
            if (!args.resource.identifier) {
                throw new Error("'resource.identifier' must be provided when 'resource' is specified.");
            }
        }

        if (!args.bindings || Object.keys(args.bindings).length === 0) {
            throw new Error("'bindings' must be provided with at least one role.");
        }

        const validPrefixes = ["user:", "group:", "serviceAccount:", "domain:"];

        for (const [roleId, principals] of Object.entries(args.bindings)) {
            if (!principals || principals.length === 0) {
                throw new Error(`Role '${roleId}' must have at least one principal.`);
            }

            for (const principal of principals) {
                const principalStr = principal as string;
                if (!validPrefixes.some((prefix) => principalStr.startsWith(prefix))) {
                    throw new Error(
                        `Invalid principal '${principalStr}' for role '${roleId}'. Must start with one of: ${validPrefixes.join(", ")}`
                    );
                }
            }
        }
    }
}
