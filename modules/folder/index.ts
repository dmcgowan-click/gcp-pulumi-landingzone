import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Iam } from "../iam";

/**
 * Input arguments for the Folder module.
 * Exactly one of organisation or folder must be provided as the parent.
 *
 * @param organisation The parent organisation numeric ID
 * @param folder The parent folder numeric ID
 * @param name The folder display name (3-30 characters)
 * @param bindings Optional IAM bindings to apply to the created folder
 */
export interface FolderArgs {
    organisation?: pulumi.Input<string>;
    folder?: pulumi.Input<string>;
    name: pulumi.Input<string>;
    bindings?: {
        [roleId: string]: pulumi.Input<string>[];
    };
}

/**
 * A Pulumi ComponentResource that creates a GCP resource folder
 * and optionally applies IAM bindings via the IAM module.
 *
 * @param name The unique name of the component resource
 * @param args The folder creation arguments
 * @param opts Optional Pulumi resource options
 * @returns A Folder component with registered outputs
 */
export class Folder extends pulumi.ComponentResource {
    public readonly folderId: pulumi.Output<string>;
    public readonly folderName: pulumi.Output<string>;
    public readonly bindings: pulumi.Output<{ [roleId: string]: string[] } | null>;

    constructor(name: string, args: FolderArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:modules:Folder", name, {}, opts);

        this.validateArgs(args);

        const parent = args.organisation
            ? `organizations/${args.organisation}`
            : `folders/${args.folder}`;

        const folder = new gcp.organizations.Folder(`${name}-folder`, {
            displayName: args.name,
            parent: parent,
        }, { parent: this });

        const folderId = folder.folderId;

        if (args.bindings && Object.keys(args.bindings).length > 0) {
            new Iam(`${name}-iam`, {
                folder: folderId,
                bindings: args.bindings,
            }, { parent: this });
        }

        this.folderId = folderId;
        this.folderName = pulumi.output(args.name);
        this.bindings = pulumi.output(
            args.bindings
                ? Object.fromEntries(
                      Object.entries(args.bindings).map(([role, principals]) => [role, principals as string[]])
                  )
                : null
        );

        this.registerOutputs({
            folderId: this.folderId,
            folderName: this.folderName,
            bindings: this.bindings,
        });
    }

    /**
     * Validates the input arguments for the Folder module.
     *
     * @param args The folder arguments to validate
     * @returns void
     */
    private validateArgs(args: FolderArgs): void {
        const folderName = args.name as string;

        if (!folderName || folderName.length < 3 || folderName.length > 30) {
            throw new Error(
                `Folder display name must be between 3 and 30 characters. Got ${folderName ? folderName.length : 0} characters.`
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
    }
}
