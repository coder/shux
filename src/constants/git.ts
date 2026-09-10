/**
 * Git routes these schemes through SSH transport, mapping `git+ssh` and `ssh+git` to `PROTO_SSH`.
 * Values match `URL.protocol`, which includes the trailing colon.
 */
export const SSH_PROTOCOL_SCHEMES: ReadonlySet<string> = new Set(["ssh:", "git+ssh:", "ssh+git:"]);
