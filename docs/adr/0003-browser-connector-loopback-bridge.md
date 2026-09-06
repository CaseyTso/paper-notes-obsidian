# Browser Connector communicates through the Obsidian Plugin loopback bridge

The Browser Connector submits Web Captures to a Capture Bridge bound only to loopback and owned by the Obsidian Plugin; the plugin then delegates every managed item write to the paper-notes CLI. The extension never invokes the CLI directly, and `obsidian://` may activate an Import Review but is not metadata transport.

This preserves reliable request-response behavior and the CLI single-writer boundary without requiring a platform-specific Native Messaging host. `obsidian://` payload transport was rejected because it has no reliable response channel, while Native Messaging was rejected because it requires separate browser/OS registration. The consequence is that Obsidian and the plugin must be running when a capture is submitted.

V1 requires no manually paired secret. Unsafe web content is excluded with a loopback-only bind, strict `Host`/route/method/content-type/body/schema checks, and a versioned non-simple connector header that requires browser preflight; requests that do not satisfy this contract cannot mutate the library. A pairing token would be reconsidered only if resistance to untrusted local processes enters the threat model.
