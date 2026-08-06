import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Project } from "../project";
import { Iam, IamCondition } from "../iam";
import { Storage } from "../storage";

/**
 * Power-user binding configuration for a Service Project.
 *
 * @param group A `group:` prefixed email of a power-user group in Google Identity
 * @param sa Optional service account configuration (created under the seed project)
 * @param bindings List of role IDs assigned to the group (and SA if enabled). Must not contain roles/resourcemanager.projectIamAdmin.
 * @param bindingProjectIAM Optional list of role IDs that the group (and SA if enabled) are permitted to grant via roles/resourcemanager.projectIamAdmin
 */
export interface ServiceProjectPowerUser {
    group: string;
    sa?: {
        enabled: boolean;
        name?: string;
    };
    bindings: string[];
    bindingProjectIAM?: string[];
}

/**
 * Read-only-user binding configuration for a Service Project.
 *
 * @param group A `group:` prefixed email of a read-only-user group in Google Identity
 * @param bindings List of role IDs assigned to the group
 */
export interface ServiceProjectROUser {
    group: string;
    bindings: string[];
}

/**
 * Input arguments for the Service Project module.
 *
 * @param organisation The organisation numeric ID, used only to scope the environment-folder lookup (not the project parent)
 * @param billing The billing account ID (format: XXXXXX-XXXXXX-XXXXXX)
 * @param environment The environment name (folder display name as defined in the organisation stack)
 * @param seedProjectID The seed project ID (hosts the power-user SA and state bucket)
 * @param name The project name base (combined with environment to form the display name and project ID base)
 * @param defaultLocation A valid GCP region used for regional resources (e.g. the state bucket location)
 * @param apis Optional additional GCP APIs to enable (appended to the required set)
 * @param bindingsPowerUser Optional power-user bindings applied to the project
 * @param bindingsROUser Optional read-only-user bindings applied to the project
 * @param stateBucket Whether to create a Pulumi state bucket under the seed project (defaults to true)
 * @param labels Optional labels to apply to the project
 */
export interface ServiceProjectArgs {
    organisation: pulumi.Input<string>;
    billing: pulumi.Input<string>;
    environment: string;
    seedProjectID: pulumi.Input<string>;
    name: string;
    defaultLocation: string;
    apis?: string[];
    bindingsPowerUser?: ServiceProjectPowerUser;
    bindingsROUser?: ServiceProjectROUser;
    stateBucket?: boolean;
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCP service project within an
 * environment folder. It composes the Project module (as an internal child)
 * and adds power-user / read-only-user IAM bindings, an optional CICD service
 * account, and an optional Pulumi state bucket hosted in the seed project.
 *
 * @param name The unique name of the component resource
 * @param args The service project creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A ServiceProject component with registered outputs
 */
export class ServiceProject extends pulumi.ComponentResource {
    public readonly projectDisplayName: pulumi.Output<string>;
    public readonly projectId: pulumi.Output<string>;
    public readonly projectNumber: pulumi.Output<string>;
    public readonly environment: pulumi.Output<string>;
    public readonly bindingsPowerUser: pulumi.Output<ServiceProjectPowerUser | null>;
    public readonly bindingsROUser: pulumi.Output<ServiceProjectROUser | null>;
    public readonly powerUserServiceAccountEmail: pulumi.Output<string | null>;
    public readonly stateBucketName: pulumi.Output<string | null>;
    public readonly labels: pulumi.Output<{ [key: string]: string }>;

    constructor(name: string, args: ServiceProjectArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:ServiceProject", name, {}, opts);

        this.validateArgs(args);

        // Resolve the environment folder ID by display name, scoped to the
        // organisation. The resolved folder is the project's parent.
        const folderId = gcp.organizations.getFoldersOutput({
            parentId: pulumi.interpolate`organizations/${args.organisation}`,
        }, { parent: this }).apply(result => {
            const match = result.folders.find(f => f.displayName === args.environment);
            if (!match) {
                throw new Error(
                    `No folder found with display name '${args.environment}' under organisation. ` +
                    `Ensure the environment folder exists (created by the organisation stack).`
                );
            }
            return match.name.replace(/^folders\//, "");
        });

        // Build the API list: required APIs plus any user-provided APIs.
        const requiredApis = [
            "cloudresourcemanager.googleapis.com",
            "cloudbilling.googleapis.com",
            "iam.googleapis.com",
            "orgpolicy.googleapis.com",
        ];
        const apis = Array.from(new Set([...requiredApis, ...(args.apis ?? [])]));

        // Service-project-level default label; parent Project module adds
        // { module: "project", deployed_by: "pulumi" } on top.
        const projectLabels = pulumi.output(args.labels || {}).apply(l => ({
            ...l,
            environment: args.environment,
        }));

        const project = new Project(`${name}-project`, {
            folder: folderId,
            billing: args.billing,
            name: `${args.name}-${args.environment}`,
            apis: apis,
            labels: projectLabels,
        }, { parent: this });

        // Optional CICD power-user service account, hosted in the seed project.
        let powerUserSaEmail: pulumi.Output<string> | undefined;
        if (args.bindingsPowerUser?.sa?.enabled) {
            const saName = args.bindingsPowerUser.sa.name ?? `cicd-${args.name}`;
            const description = `Service Account for ${args.name}. Project wide bindings on this project`;
            const sa = new gcp.serviceaccount.Account(`${name}-poweruser-sa`, {
                project: args.seedProjectID,
                accountId: saName,
                displayName: description,
                description: description,
            }, { parent: this });
            powerUserSaEmail = sa.email;
        }

        // Build the common principals list for power-user bindings.
        const powerUserPrincipals: pulumi.Input<string>[] = [];
        if (args.bindingsPowerUser) {
            powerUserPrincipals.push(args.bindingsPowerUser.group);
            if (powerUserSaEmail) {
                powerUserPrincipals.push(pulumi.interpolate`serviceAccount:${powerUserSaEmail}`);
            }
        }

        // Power-user project bindings (unconditional roles).
        if (args.bindingsPowerUser && args.bindingsPowerUser.bindings.length > 0) {
            const bindings: { [roleId: string]: pulumi.Input<string>[] } = {};
            for (const role of args.bindingsPowerUser.bindings) {
                bindings[role] = [...powerUserPrincipals];
            }
            new Iam(`${name}-poweruser-iam`, {
                project: project.projectId,
                bindings: bindings,
            }, { parent: this });
        }

        // Power-user projectIamAdmin bindings with conditions (batched in blocks of 10).
        if (args.bindingsPowerUser?.bindingProjectIAM && args.bindingsPowerUser.bindingProjectIAM.length > 0) {
            const roles = args.bindingsPowerUser.bindingProjectIAM;
            const blockSize = 10;
            const conditions: IamCondition[] = [];

            for (let blockId = 0; blockId < Math.ceil(roles.length / blockSize); blockId++) {
                const blockRoles = roles.slice(blockId * blockSize, (blockId + 1) * blockSize);
                const rolesList = blockRoles.map(r => `'${r}'`).join(", ");
                conditions.push({
                    role: "roles/resourcemanager.projectIamAdmin",
                    title: `condition_block_${blockId}`,
                    description: `Condition Block ${blockId}`,
                    expression: `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([${rolesList}])`,
                    members: [...powerUserPrincipals],
                });
            }

            new Iam(`${name}-poweruser-projectiam`, {
                project: project.projectId,
                bindings: {
                    "roles/resourcemanager.projectIamAdmin": [...powerUserPrincipals],
                },
                conditions: conditions,
            }, { parent: this });
        }

        // Read-only-user project bindings: group only.
        if (args.bindingsROUser && args.bindingsROUser.bindings.length > 0) {
            const bindings: { [roleId: string]: pulumi.Input<string>[] } = {};
            for (const role of args.bindingsROUser.bindings) {
                bindings[role] = [args.bindingsROUser.group];
            }
            new Iam(`${name}-rouser-iam`, {
                project: project.projectId,
                bindings: bindings,
            }, { parent: this });
        }

        // Optional Pulumi state bucket, hosted in the seed project.
        const createStateBucket = args.stateBucket ?? true;
        let stateBucketName: pulumi.Output<string> | null = null;
        if (createStateBucket) {
            // Bucket-level bindings (assigned only for present principals).
            const objectAdmins: pulumi.Input<string>[] = [];
            if (args.bindingsPowerUser) {
                objectAdmins.push(args.bindingsPowerUser.group);
            }
            if (powerUserSaEmail) {
                objectAdmins.push(pulumi.interpolate`serviceAccount:${powerUserSaEmail}`);
            }
            const objectViewers: pulumi.Input<string>[] = [];
            if (args.bindingsROUser) {
                objectViewers.push(args.bindingsROUser.group);
            }

            const bucketBindings: { [roleId: string]: pulumi.Input<string>[] } = {};
            if (objectAdmins.length > 0) {
                bucketBindings["roles/storage.objectAdmin"] = objectAdmins;
            }
            if (objectViewers.length > 0) {
                bucketBindings["roles/storage.objectViewer"] = objectViewers;
            }

            const stateBucket = new Storage(`${name}-state`, {
                name: pulumi.interpolate`pulumi-state-${project.projectId}`,
                postfix: false,
                project: args.seedProjectID,
                location: args.defaultLocation,
                bindings: Object.keys(bucketBindings).length > 0 ? bucketBindings : undefined,
            }, { parent: this });
            stateBucketName = stateBucket.bucketName;

            // Seed-project-level bindings: bucketViewer for present principals.
            // NOTE: Bound to the seed project (not the individual bucket) — grants
            // list/metadata access to all state buckets in the seed project. Object-level
            // access is handled separately via bucket-level bindings above.
            const seedViewers: pulumi.Input<string>[] = [];
            if (args.bindingsPowerUser) {
                seedViewers.push(args.bindingsPowerUser.group);
            }
            if (args.bindingsROUser) {
                seedViewers.push(args.bindingsROUser.group);
            }
            if (powerUserSaEmail) {
                seedViewers.push(pulumi.interpolate`serviceAccount:${powerUserSaEmail}`);
            }
            if (seedViewers.length > 0) {
                new Iam(`${name}-state-seed-iam`, {
                    project: args.seedProjectID,
                    bindings: { "roles/storage.bucketViewer": seedViewers },
                }, { parent: this });
            }
        }

        this.projectDisplayName = project.projectDisplayName;
        this.projectId = project.projectId;
        this.projectNumber = project.projectNumber;
        this.environment = pulumi.output(args.environment);
        this.bindingsPowerUser = pulumi.output(args.bindingsPowerUser ?? null);
        this.bindingsROUser = pulumi.output(args.bindingsROUser ?? null);
        this.powerUserServiceAccountEmail = powerUserSaEmail
            ? powerUserSaEmail.apply(e => e as string | null)
            : pulumi.output(null as string | null);
        this.stateBucketName = stateBucketName
            ? stateBucketName.apply(n => n as string | null)
            : pulumi.output(null as string | null);
        this.labels = project.labels;

        this.registerOutputs({
            projectDisplayName: this.projectDisplayName,
            projectId: this.projectId,
            projectNumber: this.projectNumber,
            environment: this.environment,
            bindingsPowerUser: this.bindingsPowerUser,
            bindingsROUser: this.bindingsROUser,
            powerUserServiceAccountEmail: this.powerUserServiceAccountEmail,
            stateBucketName: this.stateBucketName,
            labels: this.labels,
        });
    }

    /**
     * Validates the input arguments for the Service Project module.
     * Syntax-level validation only at construction time. Name format
     * validation is delegated to the Project module, and resource existence
     * is deferred to GCP APIs at apply time.
     *
     * @param args The service project arguments to validate
     */
    private validateArgs(args: ServiceProjectArgs): void {
        if (!args.organisation) {
            throw new Error("'organisation' must be provided.");
        }

        if (!args.billing) {
            throw new Error("'billing' must be provided.");
        }

        if (!args.environment || args.environment.length === 0) {
            throw new Error("'environment' must be provided.");
        }

        if (!args.seedProjectID) {
            throw new Error("'seedProjectID' must be provided.");
        }

        if (!args.name || args.name.length === 0) {
            throw new Error("'name' must be provided.");
        }

        if (typeof args.defaultLocation !== "string" || args.defaultLocation.length === 0) {
            throw new Error("'defaultLocation' must be provided.");
        }

        if (args.bindingsPowerUser) {
            if (!args.bindingsPowerUser.group || !args.bindingsPowerUser.group.startsWith("group:")) {
                throw new Error(
                    `'bindingsPowerUser.group' must be a 'group:' prefixed principal. Got '${args.bindingsPowerUser.group}'.`
                );
            }
            if (args.bindingsPowerUser.sa && typeof args.bindingsPowerUser.sa.enabled !== "boolean") {
                throw new Error("'bindingsPowerUser.sa.enabled' is required and must be true or false.");
            }
            if (args.bindingsPowerUser.bindings.includes("roles/resourcemanager.projectIamAdmin")) {
                throw new Error(
                    "For roles/resourcemanager.projectIamAdmin, use bindingProjectIAM and provide a list of permitted roles."
                );
            }
            if (args.bindingsPowerUser.bindingProjectIAM !== undefined &&
                args.bindingsPowerUser.bindingProjectIAM.length === 0) {
                throw new Error("'bindingsPowerUser.bindingProjectIAM' must not be empty if provided.");
            }
        }

        if (args.bindingsROUser) {
            if (!args.bindingsROUser.group || !args.bindingsROUser.group.startsWith("group:")) {
                throw new Error(
                    `'bindingsROUser.group' must be a 'group:' prefixed principal. Got '${args.bindingsROUser.group}'.`
                );
            }
        }
    }
}
