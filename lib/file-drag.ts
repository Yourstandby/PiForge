/**
 * DataTransfer type used when a file-tree row is dragged into the composer.
 * The payload is the absolute file path; the composer converts it to an
 * `@relative/path` reference for the current project.
 */
export const FILE_DRAG_MIME = "application/x-piforge-path";
