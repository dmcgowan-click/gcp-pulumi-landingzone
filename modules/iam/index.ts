import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

/**
 * Condition entry for conditional IAM bindings.
 *
 * @param role The role ID this condition applies to (must match a role in bindings)
 * @param title The condition title (validated client-side)
 * @param description Optional description of the condition
 * @param expression CEL expression for the condition (validated by API)
 * @param members List of principals this condition applies to (must match members in the corresponding role's bindings)
 */
export interface IamCondition {
    role: string;
    title: string;
    description?: string;
    expression: string;
    members: pulumi.Input<string>[];
}

/**
 * Input arguments for the IAM module.
 * Exactly one of organisation, folder, project, or resource must be provided.
 *
 * @param organisation The organisation ID to bind IAM roles to
 * @param folder The folder ID to bind IAM roles to
 * @param project The project ID to bind IAM roles to
 * @param resource The resource to bind IAM roles to (type + identifier)
 * @param bindings A map of role IDs to lists of principals
 * @param conditions Optional list of conditional IAM bindings
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
    conditions?: IamCondition[];
}

/**
 * A Pulumi ComponentResource that manages non-authoritative IAM member bindings.
 * Supports organisation, folder, project, storage bucket, and service account targets.
 * Uses IAMMember resources only — no authoritative IAMBinding or IAMPolicy.
 *
 * @param name The unique name of the component resource
 * @param args The IAM binding arguments
 * @param opts Optional Pulumi resource options
 * @returns Outputs including target, bindings, and conditions applied
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

        // Build a set of conditional member keys for lookup: "role|principal"
        const conditionalMembers = new Set<string>();
        if (args.conditions) {
            for (const condition of args.conditions) {
                for (const member of condition.members) {
                    if (typeof member === "string") {
                        conditionalMembers.add(`${condition.role}|${member}`);
                    }
                }
            }
        }

        // Create unconditional bindings
        for (const [roleId, principals] of Object.entries(args.bindings)) {
            for (let i = 0; i < principals.length; i++) {
                const principal = principals[i];
                const isPlainString = typeof principal === "string";

                // Skip principals that have a condition defined for this role
                if (isPlainString && conditionalMembers.has(`${roleId}|${principal}`)) {
                    continue;
                }

                const nameKey = isPlainString ? principal : `member-${i}`;
                const resourceName = `${name}-${roleId}-${nameKey}`.replace(/[/:]/g, "-");

                this.createIamMember(resourceName, args, roleId, principal);
            }
        }

        // Create conditional bindings
        if (args.conditions) {
            for (const condition of args.conditions) {
                const iamCondition = {
                    title: condition.title,
                    description: condition.description,
                    expression: condition.expression,
                };

                for (let i = 0; i < condition.members.length; i++) {
                    const member = condition.members[i];
                    const isPlainString = typeof member === "string";
                    const nameKey = isPlainString ? member : `member-${i}`;
                    const resourceName = `${name}-${condition.role}-${condition.title}-${nameKey}`.replace(/[/:]/g, "-");

                    this.createIamMember(resourceName, args, condition.role, member, iamCondition);
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
                Object.entries(args.bindings).map(([role, principals]) => [role, principals])
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
     * Creates an IAM member resource for the appropriate target type.
     *
     * @param resourceName The Pulumi resource name
     * @param args The IAM module arguments (for target resolution)
     * @param roleId The IAM role to assign
     * @param member The principal to assign the role to
     * @param condition Optional IAM condition to apply
     */
    private createIamMember(
        resourceName: string,
        args: IamArgs,
        roleId: string,
        member: pulumi.Input<string>,
        condition?: { title: string; description?: string; expression: string },
    ): void {
        if (args.organisation) {
            new gcp.organizations.IAMMember(resourceName, {
                orgId: args.organisation,
                role: roleId,
                member: member,
                condition: condition,
            }, { parent: this });
        } else if (args.folder) {
            new gcp.folder.IAMMember(resourceName, {
                folder: args.folder,
                role: roleId,
                member: member,
                condition: condition,
            }, { parent: this });
        } else if (args.project) {
            new gcp.projects.IAMMember(resourceName, {
                project: args.project,
                role: roleId,
                member: member,
                condition: condition,
            }, { parent: this });
        } else if (args.resource) {
            if (args.resource.type === "storage") {
                new gcp.storage.BucketIAMMember(resourceName, {
                    bucket: args.resource.identifier,
                    role: roleId,
                    member: member,
                    condition: condition,
                }, { parent: this });
            } else if (args.resource.type === "service_account") {
                new gcp.serviceaccount.IAMMember(resourceName, {
                    serviceAccountId: args.resource.identifier,
                    role: roleId,
                    member: member,
                    condition: condition,
                }, { parent: this });
            }
        }
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
                if (typeof principal !== "string") {
                    continue;
                }
                if (!validPrefixes.some((prefix) => principal.startsWith(prefix))) {
                    throw new Error(
                        `Invalid principal '${principal}' for role '${roleId}'. Must start with one of: ${validPrefixes.join(", ")}`
                    );
                }
            }
        }

        if (args.conditions) {
            const titlePattern = /^[a-zA-Z0-9_. -]+$/;

            for (const condition of args.conditions) {
                if (!condition.role) {
                    throw new Error("Each condition must have a 'role' field.");
                }

                if (!args.bindings[condition.role]) {
                    throw new Error(`Condition role '${condition.role}' does not match any role in bindings.`);
                }

                if (!condition.title) {
                    throw new Error("Each condition must have a 'title' field.");
                }

                if (condition.title.length > 100) {
                    throw new Error(`Condition title '${condition.title}' exceeds 100 characters.`);
                }

                if (!titlePattern.test(condition.title)) {
                    throw new Error(
                        `Condition title '${condition.title}' contains invalid characters. Must match ^[a-zA-Z0-9_. -]+$`
                    );
                }

                if (!condition.expression) {
                    throw new Error(`Condition '${condition.title}' must have an 'expression' field.`);
                }

                if (!condition.members || condition.members.length === 0) {
                    throw new Error(`Condition '${condition.title}' must have at least one member.`);
                }

                for (const member of condition.members) {
                    if (typeof member !== "string") {
                        continue;
                    }
                    const bindingPrincipals = args.bindings[condition.role];
                    const plainPrincipals = bindingPrincipals.filter((p) => typeof p === "string") as string[];
                    if (!plainPrincipals.includes(member)) {
                        throw new Error(
                            `Condition '${condition.title}' member '${member}' is not assigned to role '${condition.role}' in bindings.`
                        );
                    }
                }
            }
        }
    }
}
