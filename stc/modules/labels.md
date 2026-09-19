### Labels

Create a Pulumi `ComponentResource` module under `modules/labels` to sanitise labels into GCP-compliant format (and in future, manage tagging)

* Accept an input based on the following YAML definition

```yaml
labels:
  <key>: <value>
```

* Requirements
  * Input: a flat map of `{ [key: string]: string }` (at least one entry)
  * No additional dependencies beyond `@pulumi/pulumi`
  * Sanitisation rules (applied to both keys and values):
    * Convert all characters to lowercase
    * Replace any character NOT in `[a-z0-9_-]` with `_`
    * For keys only: if the first character is not `[a-z]`, prepend `l_`
    * Truncate to 63 characters maximum
    * If a key is empty after sanitisation, error with descriptive message
* Return
  * `labels` — `pulumi.Output<{ [key: string]: string }>` — the sanitised label map
* Integration
  * Stacks should instantiate `new Labels(...)` and pass `.labels` output to downstream modules
  * Module-level validation (e.g., in Project) remains as a safety net but should not need to reject labels that have been sanitised
