/**
 * Maximum decimal digits jsonSafeClone will expand a BigInt into. Generous
 * for real values (a 4096-bit RSA modulus is ~1,234 digits) while bounding
 * the superlinear BigInt#toString() cost a hostile sandbox value could
 * otherwise impose on the host event loop.
 */
export const JSON_SAFE_CLONE_MAX_BIGINT_DIGITS = 4_096;
