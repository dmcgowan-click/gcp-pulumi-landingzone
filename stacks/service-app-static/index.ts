import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as yaml from "js-yaml";
import { Labels } from "../../modules/labels";
import { IpAddress } from "../../modules/ip-address";
import { Certificate } from "../../modules/certificate";
import { Storage } from "../../modules/storage";
import { LoadBalancer } from "../../modules/load-balancer";

// Environment is the Pulumi stack name (Pulumi.<environment>.yaml) and must equal STACK_ENV.
const environment = pulumi.getStack();

/**
 * A single domain entry from the stack `domains` config.
 *
 * @param domain An FQDN for web access
 * @param zoneName Optional pre-existing managed DNS zone; when set an A record is created in it
 * @param primary When true, mark this domain's certificate as the SNI fallback
 */
interface DomainEntry {
    domain: string;
    zoneName?: string;
    primary?: boolean;
}

/**
 * Reads and parses a YAML file from the stack directory.
 *
 * @param filename The YAML filename to read (relative to stack directory)
 * @returns The parsed YAML content as a plain object
 */
function readYamlFile(filename: string): Record<string, unknown> {
    const filePath = path.join(__dirname, filename);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Required config file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, "utf8");
    return (yaml.load(content) as Record<string, unknown>) || {};
}

/**
 * Slugifies an FQDN into a GCP-name-safe fragment: lowercase, every run of
 * non-[a-z0-9] characters replaced by a single hyphen, leading/trailing hyphens stripped.
 *
 * @param domain The FQDN to slugify
 * @returns The slugified fragment (e.g. www.example.com -> www-example-com)
 */
function slugify(domain: string): string {
    return domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Builds a deterministic, GCP-compliant certificate key for a domain.
 * Slugifies the FQDN, appends a short SHA-256 suffix for uniqueness, and
 * truncates the slug so the full key stays within 63 characters.
 *
 * @param prefix The name prefix (`namePrefix`)
 * @param domain The FQDN
 * @param env The environment (Pulumi stack name)
 * @returns A key matching ^[a-z]([-a-z0-9]*[a-z0-9])?$, max 63 chars
 */
function certificateKey(prefix: string, domain: string, env: string): string {
    const hash6 = crypto.createHash("sha256").update(domain).digest("hex").slice(0, 6);
    const fullSlug = slugify(domain);
    const maxSlugLen = 63 - `${prefix}-cert--${hash6}-${env}`.length;
    let slug = fullSlug;
    if (slug.length > maxSlugLen) {
        slug = slug.slice(0, Math.max(0, maxSlugLen)).replace(/-+$/g, "");
    }
    return `${prefix}-cert-${slug}-${hash6}-${env}`;
}

const NAME_REGEX = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

// --- Common input (Pulumi-common.yaml) ---
const common = readYamlFile("Pulumi-common.yaml");
const namePrefix = common.namePrefix as string;
const defaultLocation = common.defaultLocation as string;

// --- Stack input (env-level Pulumi config) ---
const config = new pulumi.Config("service-app-static");
const serviceProjectID = config.require("serviceProjectID");
const domains = config.requireObject<DomainEntry[]>("domains");
const userLabels = config.getObject<{ [key: string]: string }>("labels") || {};

// --- Validation ---
if (!namePrefix || namePrefix.trim() === "") {
    throw new Error("Pulumi-common.yaml 'namePrefix' must be provided and non-empty");
}
if (!NAME_REGEX.test(namePrefix) || namePrefix.length > 63) {
    throw new Error(
        `Pulumi-common.yaml 'namePrefix' ('${namePrefix}') must match ^[a-z]([-a-z0-9]*[a-z0-9])?$ (lowercase alphanumeric and hyphens, starting with a lowercase letter) and be max 63 characters, as it prefixes every resource name.`,
    );
}
// Storage bucket name is `<namePrefix>-sitestatic-<env>` and must be <=58 chars before the postfix.
const bucketBaseName = `${namePrefix}-sitestatic-${environment}`;
if (bucketBaseName.length > 58) {
    throw new Error(
        `Storage bucket name '${bucketBaseName}' exceeds 58 characters (reserved for the postfix). Shorten 'namePrefix'.`,
    );
}
if (!defaultLocation || defaultLocation.trim() === "") {
    throw new Error("Pulumi-common.yaml 'defaultLocation' must be provided and non-empty");
}
if (!serviceProjectID || serviceProjectID.trim() === "") {
    throw new Error("service-app-static:serviceProjectID must be provided and non-empty");
}
if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error("service-app-static:domains must contain at least one entry");
}
for (const entry of domains) {
    // Each domain must be a single FQDN: a resolved plain string with no commas or whitespace.
    if (!entry.domain || entry.domain.trim() === "") {
        throw new Error("service-app-static:domains[].domain must be provided and non-empty");
    }
    if (/[,\s]/.test(entry.domain)) {
        throw new Error(`service-app-static:domains[].domain must be a single FQDN (no commas or whitespace): '${entry.domain}'`);
    }
}

// --- Advisory: warn where no managed zone is supplied for a domain ---
for (const entry of domains) {
    if (!entry.zoneName || entry.zoneName.trim() === "") {
        pulumi.log.warn(
            `No 'zoneName' provided for domain '${entry.domain}'. You are responsible for ` +
            `creating the DNS A/AAAA records for this domain pointing at the reserved global IP.`,
        );
    }
}

// --- Labels ---
// The `labels` module requires at least one entry, so only sanitise when the user supplied labels.
const stackLabels: pulumi.Output<{ [key: string]: string }> = Object.keys(userLabels).length > 0
    ? new Labels("service-app-static-labels", { labels: userLabels }).labels.apply(sanitised => ({
        ...sanitised,
        stack: "service-app-static",
    } as { [key: string]: string }))
    : pulumi.output({ stack: "service-app-static" } as { [key: string]: string });

// --- Reserve a global IP address ---
const globalIp = new IpAddress(`${namePrefix}-ip-global`, {
    name: `${namePrefix}-ipadd-global-${environment}`,
    project: serviceProjectID,
    type: {
        external: {
            type: "Global",
        },
    },
    labels: stackLabels,
});

// --- Generate a certificate map (one certificate per domain) ---
const certificates: {
    [key: string]: { domains: string; primary?: boolean; labels: pulumi.Output<{ [key: string]: string }> };
} = {};
for (const entry of domains) {
    const key = certificateKey(namePrefix, entry.domain, environment);
    certificates[key] = {
        domains: entry.domain,
        labels: stackLabels,
        ...(entry.primary !== undefined ? { primary: entry.primary } : {}),
    };
}

const certificate = new Certificate(`${namePrefix}-certmap`, {
    project: serviceProjectID,
    certificateMap: {
        name: `${namePrefix}-certmap-${environment}`,
        labels: stackLabels,
        certificates,
    },
});

// --- Create a storage bucket ---
const bucket = new Storage(`${namePrefix}-sitestatic`, {
    name: bucketBaseName,
    postfix: true,
    project: serviceProjectID,
    location: defaultLocation,
    labels: stackLabels,
});

// --- Create a load balancer ---
const loadBalancer = new LoadBalancer(`${namePrefix}-lb`, {
    name: `${namePrefix}-lb-ext-global-${environment}`,
    project: serviceProjectID,
    type: {
        application: {
            external: {
                regionGlobal: {
                    frontend: {
                        tls: {
                            protocol: {
                                type: "HTTPS",
                                certificateMap: certificate.certificateMapName!,
                            },
                            ipAddress: {
                                type: "static",
                                addressName: globalIp.name,
                            },
                        },
                    },
                    backend: {
                        "storage-static": {
                            bucket: {
                                bucketName: bucket.bucketName,
                            },
                            cloudCDN: {
                                enabled: true,
                            },
                        },
                    },
                    routing: {
                        mode: "advancedHostAndPathRule",
                        defaultBackend: "storage-static",
                    },
                },
            },
        },
    },
    labels: stackLabels,
});

// --- Create FQDN A records for domains that supply a pre-existing managed zone ---
export const dnsRecordNames: pulumi.Output<string>[] = [];
for (const entry of domains) {
    if (entry.zoneName && entry.zoneName.trim() !== "") {
        const dnsName = entry.domain.endsWith(".") ? entry.domain : `${entry.domain}.`;
        const record = new gcp.dns.RecordSet(`${namePrefix}-dnsrec-${slugify(entry.domain)}-${environment}`, {
            project: serviceProjectID,
            managedZone: entry.zoneName,
            name: dnsName,
            type: "A",
            ttl: 300,
            rrdatas: [globalIp.address],
        });
        dnsRecordNames.push(record.name);
    }
}

// --- Stack outputs ---
export const ipAddress = globalIp.address;
export const ipAddressName = globalIp.name;
export const ipAddressSelfLink = globalIp.selfLink;
export const certificateMapResourceUrl = certificate.certificateMapResourceUrl!;
export const certificateMapName = certificate.certificateMapName!;
export const certificateMapId = certificate.certificateMapId!;
export const bucketName = bucket.bucketName;
export const loadBalancerIpAddresses = loadBalancer.ipAddresses;
export const loadBalancerUrlMapSelfLink = loadBalancer.urlMapSelfLink;
export const loadBalancerForwardingRuleSelfLinks = loadBalancer.forwardingRuleSelfLinks;
