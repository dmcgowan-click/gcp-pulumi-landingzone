import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Project } from "../project";
import { Iam, IamCondition } from "../iam";
import { OrgPolicy } from "../org-policy";
import { Storage } from "../storage";
import { DnsZone } from "../dns-zone";

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
 * DNS zone configuration for project zones.
 *
 * @param publicDefault Optional public default zone delegated from the root zone
 * @param additional Optional map of additional zones keyed by dnsName
 */
export interface ServiceProjectZones {
    publicDefault?: {
        rootZoneName: string;
    };
    additional?: {
        [dnsName: string]: {
            visibility?: string;
            zoneName?: string;
            description?: string;
        };
    };
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
 * @param cicdProjectID Optional CICD project ID. When provided (and bindingsPowerUser is set), the power-user group is granted roles to run/view Cloud Build triggers and view Artifact Registry artifacts in that project. Omit when no CICD project exists.
 * @param bindingsPowerUser Optional power-user bindings applied to the project
 * @param bindingsROUser Optional read-only-user bindings applied to the project
 * @param stateBucket Whether to create a Pulumi state bucket under the seed project (defaults to true)
 * @param projectZones Optional DNS zones to create for this project
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
    cicdProjectID?: pulumi.Input<string>;
    bindingsPowerUser?: ServiceProjectPowerUser;
    bindingsROUser?: ServiceProjectROUser;
    stateBucket?: boolean;
    projectZones?: ServiceProjectZones;
    labels?: pulumi.Input<{ [key: string]: string }>;
}

/**
 * A Pulumi ComponentResource that creates a GCP service project within an
 * environment folder. It composes the Project module (as an internal child)
 * and adds power-user / read-only-user IAM bindings, an optional CICD service
 * account, an optional Pulumi state bucket hosted in the seed project, and
 * optional DNS zones.
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
    public readonly zones: pulumi.Output<{ zoneName: string; dnsName: string }[] | null>;
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
        if (args.projectZones) {
            requiredApis.push("dns.googleapis.com");
        }
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

        // FUTURE ENHANCEMENT: There will be many use cases where default service accounts will require IAM bindings / policy adjustments.
        //                     We may eventually look at moving this logic to it's own module to cut down on complexity here
        // When compute API is enabled, the HTTPS LB service agent
        // needs an allowedMemberSubjects exception at the project level.
        const httpsLbApis = ["compute.googleapis.com"];
        if (apis.some(api => httpsLbApis.includes(api))) {
            const quotaProvider = new gcp.Provider(`${name}-quota-provider`, {
                billingProject: project.projectId,
                userProjectOverride: true,
            }, { parent: this, dependsOn: [project] });

            const allowedMemberSubjects = [
                pulumi.interpolate`serviceAccount:service-${project.projectNumber}@https-lb.iam.gserviceaccount.com`,
            ];
            const allowedPrincipalSets = [`//cloudresourcemanager.googleapis.com/organizations/${args.organisation}`];
            new OrgPolicy(`${name}-orgpolicy-https-lb-sa`, {
                project: project.projectId,
                policyName: "iam.managed.allowedPolicyMembers",
                spec: {
                    rules: [{
                        enforce: "TRUE",
                        parameters: pulumi.all(allowedMemberSubjects).apply(subjects =>
                            JSON.stringify({ allowedPrincipalSets, allowedMemberSubjects: subjects }),
                        ),
                    } as any],
                },
            }, { parent: this, providers: [quotaProvider], dependsOn: [project] });
        }

        // Optional CICD power-user service account, hosted in the seed project.
        let powerUserSaEmail: pulumi.Output<string> | undefined;
        if (args.bindingsPowerUser?.sa?.enabled) {
            const saName = args.bindingsPowerUser.sa.name ?? `cicd-${args.name}-${args.environment}`;
            const description = `Service Account for ${args.name}-${args.environment}. Project wide bindings on this project`;
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

            for (let blockIndex = 0; blockIndex < Math.ceil(roles.length / blockSize); blockIndex++) {
                const blockRoles = roles.slice(blockIndex * blockSize, (blockIndex + 1) * blockSize);
                const blockId = blockIndex + 1;
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

        // Power-user CICD project bindings: grant the group access to run/view
        // Cloud Build triggers and view Artifact Registry artifacts. Only
        // created when a CICD project ID is supplied (the caller omits it when
        // no CICD project exists).
        if (args.cicdProjectID && args.bindingsPowerUser) {
            new Iam(`${name}-poweruser-cicd-iam`, {
                project: args.cicdProjectID,
                bindings: {
                    "roles/cloudbuild.builds.editor": [args.bindingsPowerUser.group],
                    "roles/artifactregistry.reader": [args.bindingsPowerUser.group],
                },
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

        // Optional DNS zones.
        const createdZones: pulumi.Output<{ zoneName: string; dnsName: string }>[] = [];

        if (args.projectZones?.publicDefault) {
            const rootZoneName = args.projectZones.publicDefault.rootZoneName;

            // Look up root zone to acquire its dnsName (FQDN).
            const rootZoneLookup = gcp.dns.getManagedZoneOutput({
                name: rootZoneName,
                project: args.seedProjectID,
            }, { parent: this });

            const rootZoneDnsName = rootZoneLookup.dnsName;

            // Build child zone dnsName from project name + root zone FQDN.
            const childDnsName = rootZoneDnsName.apply(rootDns => {
                const normalised = rootDns.endsWith(".") ? rootDns : `${rootDns}.`;
                return `${args.name}-${args.environment}.${normalised}`;
            });

            // Derive zoneName: dots replaced by hyphens, trailing hyphen removed.
            const childZoneName = childDnsName.apply(dns => {
                const withoutTrailingDot = dns.endsWith(".") ? dns.slice(0, -1) : dns;
                return withoutTrailingDot.replace(/\./g, "-");
            });

            const publicDefaultZone = new DnsZone(`${name}-zone-default`, {
                zoneName: childZoneName,
                dnsName: childDnsName,
                description: childDnsName.apply(dns => `DNS zone for ${dns}`),
                visibility: "public",
                project: project.projectId,
                labels: projectLabels,
            }, { parent: this });

            // NS delegation record in the root zone.
            new gcp.dns.RecordSet(`${name}-zone-default-ns`, {
                managedZone: rootZoneName,
                name: childDnsName,
                type: "NS",
                ttl: 300,
                rrdatas: publicDefaultZone.nameServers,
                project: args.seedProjectID,
            }, { parent: this });

            createdZones.push(pulumi.all([publicDefaultZone.zoneName, publicDefaultZone.dnsName]).apply(
                ([zn, dn]) => ({ zoneName: zn, dnsName: dn })
            ));
        }

        if (args.projectZones?.additional) {
            for (const [dnsName, config] of Object.entries(args.projectZones.additional)) {
                // Derive zoneName from dnsName if not provided.
                const withoutTrailingDot = dnsName.endsWith(".") ? dnsName.slice(0, -1) : dnsName;
                const zoneName = config.zoneName ?? withoutTrailingDot.replace(/\./g, "-");
                const description = config.description ?? `DNS zone for ${dnsName}`;
                const visibility = config.visibility ?? "public";

                if (visibility === "private") {
                    throw new Error("Private DNS zones are not yet supported.");
                }

                const zone = new DnsZone(`${name}-zone-${zoneName}`, {
                    zoneName: zoneName,
                    dnsName: dnsName,
                    description: description,
                    visibility: visibility,
                    project: project.projectId,
                    labels: projectLabels,
                }, { parent: this });

                createdZones.push(pulumi.all([zone.zoneName, zone.dnsName]).apply(
                    ([zn, dn]) => ({ zoneName: zn, dnsName: dn })
                ));
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
        this.zones = createdZones.length > 0
            ? pulumi.all(createdZones).apply(z => z as { zoneName: string; dnsName: string }[])
            : pulumi.output(null as { zoneName: string; dnsName: string }[] | null);
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
            zones: this.zones,
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

        if (args.projectZones?.publicDefault) {
            if (!args.projectZones.publicDefault.rootZoneName || args.projectZones.publicDefault.rootZoneName.length === 0) {
                throw new Error("'projectZones.publicDefault.rootZoneName' must be provided.");
            }
        }
    }
}
