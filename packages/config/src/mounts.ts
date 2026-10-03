/**
  * Where each component lives under the single server hostname.
  * Path-based addressing (spec §15.1): one hostname, one certificate, no wildcard DNS.
  * The Registry Server owns the root so that `https://{domain}/@ns/name` resolves a Resource.
  */
export const MOUNTS = {
    registry: "/",
    codeRepository: "/packages",
    auth: "/auth",
} as const;
