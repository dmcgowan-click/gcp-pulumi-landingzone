import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as inputs from "@pulumi/gcp/types/input";

/**
 * Input arguments for the OrgPolicy module.
 * Exactly one of organisation, folder, or project must be provided as the target.
 *
 * @param organisation The target organisation numeric ID
 * @param folder The target folder numeric ID
 * @param project The target project ID
 * @param policyName The organisation policy constraint name (e.g. iam.disableServiceAccountKeyUpload)
 * @param spec The enforced policy specification
 * @param dryRunSpec The dry-run (audit-only) policy specification
 */
export interface OrgPolicyArgs {
    organisation?: pulumi.Input<string>;
    folder?: pulumi.Input<string>;
    project?: pulumi.Input<string>;
    policyName: string;
    spec?: pulumi.Input<inputs.orgpolicy.PolicySpec>;
    dryRunSpec?: pulumi.Input<inputs.orgpolicy.PolicyDryRunSpec>;
}

/**
 * A Pulumi ComponentResource that manages GCP organisation policies.
 * Supports targeting organisations, folders, or projects.
 *
 * @param name The unique name of the component resource
 * @param args The org policy arguments
 * @param opts Optional Pulumi resource options
 * @returns An OrgPolicy component with registered outputs
 */
export class OrgPolicy extends pulumi.ComponentResource {
    public readonly policyName: pulumi.Output<string>;
    public readonly parent: pulumi.Output<string>;
    public readonly spec: pulumi.Output<inputs.orgpolicy.PolicySpec | null>;
    public readonly dryRunSpec: pulumi.Output<inputs.orgpolicy.PolicyDryRunSpec | null>;

    constructor(name: string, args: OrgPolicyArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:OrgPolicy", name, {}, opts);

        this.validateArgs(args);

        let policyFullName: pulumi.Output<string>;
        let parentId: pulumi.Output<string>;

        if (args.organisation) {
            policyFullName = pulumi.interpolate`organizations/${args.organisation}/policies/${args.policyName}`;
            parentId = pulumi.interpolate`organizations/${args.organisation}`;
        } else if (args.folder) {
            policyFullName = pulumi.interpolate`folders/${args.folder}/policies/${args.policyName}`;
            parentId = pulumi.interpolate`folders/${args.folder}`;
        } else {
            policyFullName = pulumi.interpolate`projects/${args.project}/policies/${args.policyName}`;
            parentId = pulumi.interpolate`projects/${args.project}`;
        }

        new gcp.orgpolicy.Policy(`${name}-policy`, {
            name: policyFullName,
            parent: parentId,
            spec: args.spec,
            dryRunSpec: args.dryRunSpec,
        }, { parent: this });

        this.policyName = pulumi.output(args.policyName);
        this.parent = parentId;
        this.spec = pulumi.output(args.spec ?? null);
        this.dryRunSpec = pulumi.output(args.dryRunSpec ?? null);

        this.registerOutputs({
            policyName: this.policyName,
            parent: this.parent,
            spec: this.spec,
            dryRunSpec: this.dryRunSpec,
        });
    }

    /**
     * Validates the input arguments for the OrgPolicy module.
     * Syntax-level validation only at construction time.
     * Resource existence deferred to GCP APIs at apply time.
     *
     * @param args The org policy arguments to validate
     */
    private validateArgs(args: OrgPolicyArgs): void {
        const targets = [args.organisation, args.folder, args.project].filter(
            (t) => t !== undefined && t !== null
        );

        if (targets.length === 0) {
            throw new Error("Exactly one of 'organisation', 'folder', or 'project' must be provided. None were provided.");
        }

        if (targets.length > 1) {
            throw new Error("Exactly one of 'organisation', 'folder', or 'project' must be provided. More than one was provided.");
        }

        if (!args.policyName || args.policyName.trim() === "") {
            throw new Error("'policyName' must be provided and non-empty.");
        }

        if (!args.spec && !args.dryRunSpec) {
            throw new Error("At least one of 'spec' or 'dryRunSpec' must be provided.");
        }
    }
}
