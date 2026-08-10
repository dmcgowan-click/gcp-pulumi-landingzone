# Standard Template Constructs

* Use TypeScript
  * TypeScript Configuration
    * `tsconfig.json` must target `ES2020` for both `target` and `lib` options — the bundled ts-node in `@pulumi/pulumi` does not support newer targets (e.g. ES2022)
    * `rootDir` must be set to `../..` (relative to the stack directory) so that modules outside the stack directory are included in compilation
    * `include` must contain `../../modules/**/*.ts` to compile shared modules
* All classes and functions should have details comments in the following format

```ts
/**
 * <description>
 *
 * @param <name> <description>
 * @returns <description>
 */
```

* Pulumi requirements
  * **Never create resources inside `.apply()` callbacks.** Resources created inside `.apply()` cannot be tracked by Pulumi's state engine and will appear as new resources on every `pulumi up`, causing repeated creates/updates. Instead:
    * Use `pulumi.interpolate` to construct string Outputs (e.g. `` pulumi.interpolate`serviceAccount:${sa.email}` ``)
    * Pass `pulumi.Output<string>` values directly to resource arguments that accept `pulumi.Input<string>`
    * Since the majority of inputs to modules come from other created resources (and are therefore Outputs), modules must be designed to accept `pulumi.Input<string>` for any field that might receive a resource output

## Conventions

Reusable rules referenced throughout by tag. Apply wherever referenced.

* **[CONV-INPUT]** — Fields that may receive Outputs from other resources must use `pulumi.Input<string>` (or `pulumi.Input<string>[]` for arrays). Construction-time validation is skipped for unresolved Outputs.
* **[CONV-EXCLUSIVE]** — Exactly one of the listed target fields must be provided. Error if more than one is provided OR none are provided.
* **[CONV-VALIDATE-API]** — Format/existence validation deferred to GCP API at apply time. Only syntax-level checks at construction time.
* **[CONV-POSTFIX]** — A 4-character lowercase hexadecimal postfix (`0-9a-f`). Use `@pulumi/random` `RandomId` with `byteLength: 2`. Access via `.hex` (NOT `.dec` or `.b64Std`). Must NOT regenerate once created — use `keepers` tied to the resource name for stability.
* **[CONV-LABELS]** — Label validation at construction time: keys must match `^[a-z][a-z0-9_-]*$`, values must match `^[a-z0-9_-]*$`, both max 63 chars. Error with descriptive message if invalid. The `labels` arg receives pre-merged labels from the calling stack. Module merges with its own defaults (module defaults win on key collision).

## Stacks

* Use `@pulumi/gcp`, `@pulumi/pulumi` unless otherwise specified
* Pulumi usage (`pulumi preview`, `pulumi up`)
  * All `stacks` should be executable via the `Makefile` in the root of the working directory
  * The `Makefile` must rsync both the stack directory and the `modules/` directory into the working directory so that relative imports from modules resolve correctly
  * `package.json` must be created based on the `import` blocks in the stack and consumed modules
  * `package-lock.json` does not need to be created, but may be created by the user at their discretion
* Pulumi State Backend
  * If `PULUMI_STATE_BUCKET` is set, login to GCS backend (`pulumi login gs://<bucket>`)
  * If `PULUMI_STATE_BUCKET` is not set, use local state (`pulumi login --local`)
* All stacks are made up of discrete functions which may call modules as defined
  * Example for an organisation stack:
    * `createFolders(...)` — creates the `common` folder and environment folders
    * `createSuperAdminBindings(...)` — creates IAM bindings for the super admin group
  * Structure should be
    * `stacks/<stack name>/index.ts`
    * `stacks/<stack name>/package.json`
  * Module Resolution
    * Modules use relative imports for `@pulumi/*` packages — these resolve via Node's `node_modules` directory walking
    * The `Makefile` `prepare-infra` target must symlink the stack's `node_modules` into the `modules/` directory so that modules can resolve their dependencies: `ln -sfn <stack_node_modules> <modules_dir>/node_modules`
* Resource Options
  * Do NOT use `parent` or `dependsOn` referencing a ComponentResource instance from outside that component's constructor. The implicit dependency via Output properties (e.g. `project: myProject.projectId`) is sufficient and avoids Pulumi runtime crashes with "promises still active" errors.
* Where a YAML definition is provided, add it to the `Pulumi.<env>.yaml` file/s alongside any default required values
  * Config values will fall under a config namespace matching the stack name (e.g. `organisation:organisation`, `organisation:environments`)
  * Where existing key / values have been populated, leave values as they are
  * Where new keys with descriptive values have been added, prompt the user for input
* Stack Outputs
  * Use module-level `export const` declarations for stack outputs (e.g. `export const myOutput = value`)
  * Do NOT use `pulumi.export("name", value)` — this is a Python SDK pattern and does not exist in the Node.js SDK

## Modules

* Use `@pulumi/gcp`, `@pulumi/pulumi` at minimum. Modules may require additional libraries (e.g. `@pulumi/random`) — these must be documented in the module STC and included in the calling stack's `package.json`.
* Pulumi
  * `package.json` to be defined in calling stack. Implement code only
* All modules are to be `pulumi.ComponentResource` modules, not native methods / functions
  * Structure should be `modules/<module name>/index.ts`
  * The ComponentResource input interface must be named `<ModuleName>Args` (e.g. `IamArgs`)
  * The ComponentResource type string must follow `custom:modules:<ModuleName>` (e.g. `custom:modules:Iam`)
* Where a YAML definition is provided use as a guide, but input should be a method / function object as it will be called by an underlying stack
* Modules are consumed by stacks via relative import and are not deployed independently. No Makefile target required.
* Validation
  * Syntax-level validation only at construction time — verify format and required fields are present. Do not verify resource existence; defer to GCP APIs at apply time.
  * Validation can only check values that are resolved (plain strings) at construction time; unresolved Outputs are skipped
* Where module supports labels
  * Merge priority (later wins on key collision): user-provided labels (passed via `labels` arg) → module-level defaults (e.g. `module: "project"`, `deployed_by: "pulumi"`)
  * Calling stacks are responsible for merging stack-level labels before passing to the module
