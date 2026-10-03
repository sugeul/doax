/**
  * Claims of a Registry token (spec §7.2). The token is signed and offline-verifiable,
  * and MUST NOT carry per-Resource permissions.
  */
export interface RegistryTokenClaims {
    /** Issuer: the Auth Server identity. */
    iss: string;
    /** Principal identity as asserted by the issuer. */
    sub: string;
    /** Namespaces the Principal may access. */
    namespaces: string[];
    /** Issued at, seconds since epoch. */
    iat: number;
    /** Expires at, seconds since epoch. */
    exp: number;
}
