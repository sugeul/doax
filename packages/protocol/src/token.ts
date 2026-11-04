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
    /**
      * Audience (spec §7.2): where the token may be presented. `registry` for the Registry
      * itself, otherwise the registered name of one Provider. Absent means a Registry token.
      * A Registry refuses a Provider-audience token; a Provider refuses every audience but its own.
      */
    aud?: string;
    /** Channel (spec §7.2): what kind of client the token was issued to. */
    chn?: "executor" | "web";
    /**
      * Method (spec §7.2): how the token was obtained. `registry:exchange` for a Provider token
      * exchanged from a Registry token; otherwise the identity of the sign-in that issued it.
      */
    ath?: string;
}
