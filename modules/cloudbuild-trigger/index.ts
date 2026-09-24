import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as crypto from "crypto";
import { Iam } from "../iam";

/**
 * Input arguments for the CloudBuildTrigger module.
 *
 * @param name GCP resource name prefix (^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars)
 * @param project Project where the trigger and its service account are created, and where artifact reader is granted
 * @param description Trigger/SA description (defaults to "Trigger <name>")
 * @param region The trigger location
 * @param event The repository event that fires the trigger
 * @param source Full 2nd gen repository resource name
 * @param branch Branch (or tag, for push-new-tag) regex to trigger on (defaults to ".*")
 * @param includedFiles Glob patterns; the build only runs when a changed file matches one of them
 * @param ignoredFiles Glob patterns; changes limited to matching files will not fire the build
 * @param configuration Build configuration (only inline-custom supported)
 * @param saAssume Service account emails the trigger SA may impersonate (serviceAccountTokenCreator)
 * @param artifactWrite When true, grants the trigger SA artifactregistry.writer on the project (write to any registry)
 * @param requireApproval When true, builds require manual approval before they run
 */
export interface CloudBuildTriggerArgs {
    name: string;
    project: pulumi.Input<string>;
    description?: string;
    region: string;
    event: "push-to-branch" | "push-new-tag" | "pull-request";
    source: pulumi.Input<string>;
    branch?: string;
    includedFiles?: pulumi.Input<string>[];
    ignoredFiles?: pulumi.Input<string>[];
    configuration?: {
        type?: string;
        location?: string;
        inlineCustom?: gcp.types.input.cloudbuild.TriggerBuild;
    };
    saAssume?: pulumi.Input<string>[];
    artifactWrite?: boolean;
    requireApproval?: boolean;
}

/**
 * A Pulumi ComponentResource that creates a Cloud Build trigger and an associated
 * service account granted artifact-registry read on the project and, optionally,
 * token-creator on a set of service accounts it may impersonate.
 *
 * @param name The unique name of the component resource
 * @param args The trigger creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A CloudBuildTrigger component with registered outputs
 */
export class CloudBuildTrigger extends pulumi.ComponentResource {
    public readonly triggerId: pulumi.Output<string>;
    public readonly triggerName: pulumi.Output<string>;
    public readonly serviceAccountEmail: pulumi.Output<string>;

    constructor(name: string, args: CloudBuildTriggerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:CloudBuildTrigger", name, {}, opts);

        this.validateArgs(args);

        const description = args.description ?? `Trigger ${args.name}`;
        const branch = args.branch ?? ".*";

        const sa = new gcp.serviceaccount.Account(`${name}-sa`, {
            accountId: this.buildAccountId(args.name),
            project: args.project,
            description: `Service Account for ${description}. Assume to authorised service accounts`,
        }, { parent: this });

        const saMember = pulumi.interpolate`serviceAccount:${sa.email}`;

        const repositoryEventConfig: gcp.types.input.cloudbuild.TriggerRepositoryEventConfig =
            args.event === "push-to-branch"
                ? { repository: args.source, push: { branch } }
                : args.event === "push-new-tag"
                    ? { repository: args.source, push: { tag: branch } }
                    : { repository: args.source, pullRequest: { branch } };

        // Builds run under a custom SA must declare a logging option; default to Cloud Logging if unset.
        const inlineCustom = args.configuration?.inlineCustom;
        const build: gcp.types.input.cloudbuild.TriggerBuild | undefined = inlineCustom && {
            ...inlineCustom,
            options: {
                logging: "CLOUD_LOGGING_ONLY",
                ...inlineCustom.options,
            },
        };

        const trigger = new gcp.cloudbuild.Trigger(`${name}-trigger`, {
            project: args.project,
            location: args.region,
            name: args.name,
            description,
            serviceAccount: pulumi.interpolate`projects/${args.project}/serviceAccounts/${sa.email}`,
            repositoryEventConfig,
            includedFiles: args.includedFiles,
            ignoredFiles: args.ignoredFiles,
            approvalConfig: args.requireApproval ? { approvalRequired: true } : undefined,
            build,
        }, { parent: this });

        const projectBindings: { [role: string]: pulumi.Input<string>[] } = {
            // writer supersedes reader; use writer alone when artifact push is required
            [args.artifactWrite ? "roles/artifactregistry.writer" : "roles/artifactregistry.reader"]: [saMember],
            "roles/logging.logWriter": [saMember],
        };

        new Iam(`${name}-project-iam`, {
            project: args.project,
            bindings: projectBindings,
        }, { parent: this });

        if (args.saAssume) {
            for (let i = 0; i < args.saAssume.length; i++) {
                // IAMMember requires the fully-qualified SA resource name; use the project wildcard "-".
                const saId = pulumi.interpolate`projects/-/serviceAccounts/${args.saAssume[i]}`;
                new Iam(`${name}-assume-${i}`, {
                    resource: { type: "service_account", identifier: saId },
                    bindings: {
                        "roles/iam.serviceAccountTokenCreator": [saMember],
                    },
                }, { parent: this });
            }
        }

        this.triggerId = trigger.triggerId;
        this.triggerName = trigger.name;
        this.serviceAccountEmail = sa.email;

        this.registerOutputs({
            triggerId: this.triggerId,
            triggerName: this.triggerName,
            serviceAccountEmail: this.serviceAccountEmail,
        });
    }

    /**
     * Builds the service account ID `cb-<name>`, deterministically shortened to
     * 30 characters with a hash suffix when the full ID would exceed the limit.
     *
     * @param name The trigger name
     * @returns A service account ID no longer than 30 characters
     */
    private buildAccountId(name: string): string {
        const full = `cb-${name}`;
        if (full.length <= 30) {
            return full;
        }
        const hash = crypto.createHash("sha256").update(full).digest("hex").slice(0, 6);
        const keep = full.slice(0, 30 - hash.length - 1).replace(/-+$/, "");
        return `${keep}-${hash}`;
    }

    /**
     * Validates the input arguments for the CloudBuildTrigger module.
     * Syntax-level validation only; resource existence is deferred to GCP APIs at apply time.
     * Values that are unresolved Outputs are skipped.
     *
     * @param args The trigger arguments to validate
     */
    private validateArgs(args: CloudBuildTriggerArgs): void {
        const nameRegex = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
        if (!args.name || args.name.length > 63 || !nameRegex.test(args.name)) {
            throw new Error(
                `'name' must match ^[a-z]([-a-z0-9]*[a-z0-9])?$ and be max 63 characters. Got '${args.name}'.`
            );
        }

        if (typeof args.project === "string" && args.project.trim() === "") {
            throw new Error("'project' must be provided and non-empty.");
        }

        if (!args.region || args.region.trim() === "") {
            throw new Error("'region' must be provided and non-empty.");
        }

        const validEvents = ["push-to-branch", "push-new-tag", "pull-request"];
        if (!validEvents.includes(args.event)) {
            throw new Error(`'event' must be one of ${validEvents.join(", ")}. Got '${args.event}'.`);
        }

        if (typeof args.source === "string" && args.source.trim() === "") {
            throw new Error("'source' must be provided and non-empty.");
        }

        const configType = args.configuration?.type ?? "Cloud Build configuration file";
        if (configType !== "Cloud Build configuration file") {
            throw new Error(
                `'configuration.type' only supports 'Cloud Build configuration file'. Got '${configType}'.`
            );
        }

        const configLocation = args.configuration?.location ?? "inline-custom";
        if (configLocation !== "inline-custom") {
            throw new Error(
                `'configuration.location' only supports 'inline-custom'. Got '${configLocation}'.`
            );
        }

        if (!args.configuration?.inlineCustom) {
            throw new Error("'configuration.inlineCustom' is required when location is 'inline-custom'.");
        }

        if (args.saAssume) {
            for (const entry of args.saAssume) {
                if (typeof entry === "string" && entry.trim() === "") {
                    throw new Error("Each 'saAssume' entry must be a non-empty service account email.");
                }
            }
        }

        for (const field of ["includedFiles", "ignoredFiles"] as const) {
            const patterns = args[field];
            if (patterns) {
                for (const entry of patterns) {
                    if (typeof entry === "string" && entry.trim() === "") {
                        throw new Error(`Each '${field}' entry must be a non-empty glob pattern.`);
                    }
                }
            }
        }
    }
}
